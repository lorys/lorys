// Accounts are a JSON array of { username, password, progress?, watched? } encrypted with AES-256-GCM.
// File layout (base64): salt(16) | iv(12) | authTag(16) | ciphertext.
// The key is derived from ACCOUNTS_SECRET with scrypt and the per-file salt.
// Passwords may be stored in clear (inside the encrypted file) or as
// "scrypt:<salt>:<hash>" hashes, which is what the accounts CLI writes.
// `progress` maps a movie id to { position, duration, updatedAt } (seconds / ISO date).
// `watched` maps a movie or episode id to the ISO date it was last watched to the end.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

function encryptWithKey(accounts, salt, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(accounts), 'utf8'), cipher.final()]);
  return Buffer.concat([salt, iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function splitPayload(payload) {
  const data = Buffer.from(payload.trim(), 'base64');
  if (data.length < SALT_LEN + IV_LEN + TAG_LEN) throw new Error('Accounts file is too short to be valid');
  return {
    salt: data.subarray(0, SALT_LEN),
    iv: data.subarray(SALT_LEN, SALT_LEN + IV_LEN),
    tag: data.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN),
    ciphertext: data.subarray(SALT_LEN + IV_LEN + TAG_LEN),
  };
}

function decryptWithKey({ iv, tag, ciphertext }, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Unable to decrypt accounts file (wrong ACCOUNTS_SECRET or corrupted file)');
  }
  const accounts = JSON.parse(plaintext);
  if (!Array.isArray(accounts)) throw new Error('Accounts file must contain a JSON array');
  return accounts;
}

async function writeFileAtomic(filePath, content) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

export function encryptAccounts(accounts, secret) {
  const salt = crypto.randomBytes(SALT_LEN);
  return encryptWithKey(accounts, salt, crypto.scryptSync(secret, salt, 32));
}

export function decryptAccounts(payload, secret) {
  const parts = splitPayload(payload);
  return decryptWithKey(parts, crypto.scryptSync(secret, parts.salt, 32));
}

export async function readAccounts(filePath, secret) {
  let payload;
  try {
    payload = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return decryptAccounts(payload, secret);
}

export async function writeAccounts(filePath, accounts, secret) {
  await writeFileAtomic(filePath, encryptAccounts(accounts, secret) + '\n');
}

/**
 * In-memory view of the accounts file for the server, which writes it often
 * (watch progress). The derived key is cached so scrypt only runs when the salt
 * changes, operations are serialized, and the file is reloaded whenever someone
 * else (the accounts CLI) modified it, so their changes are never overwritten.
 */
export function createAccountsStore(filePath, secret) {
  let state = null; // { accounts, salt, key, mtimeMs, size }
  let queue = Promise.resolve();

  async function load() {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      state = { accounts: [], salt: state?.salt ?? null, key: state?.key ?? null, mtimeMs: 0, size: 0 };
      return state;
    }
    if (state && state.mtimeMs === stat.mtimeMs && state.size === stat.size) return state;

    const parts = splitPayload(await fs.readFile(filePath, 'utf8'));
    const key = state?.salt?.equals(parts.salt) ? state.key : await scrypt(secret, parts.salt, 32);
    state = { accounts: decryptWithKey(parts, key), salt: Buffer.from(parts.salt), key, mtimeMs: stat.mtimeMs, size: stat.size };
    return state;
  }

  function serialized(fn) {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  return {
    /** Current accounts. Treat the result as read-only. */
    read: () => serialized(async () => (await load()).accounts),

    /** Run `mutate(accounts)` and persist the result. Returns what `mutate` returns. */
    update: (mutate) =>
      serialized(async () => {
        const current = await load();
        const accounts = structuredClone(current.accounts);
        const result = await mutate(accounts);
        if (!current.key) {
          current.salt = crypto.randomBytes(SALT_LEN);
          current.key = await scrypt(secret, current.salt, 32);
        }
        await writeFileAtomic(filePath, encryptWithKey(accounts, current.salt, current.key) + '\n');
        const stat = await fs.stat(filePath);
        state = { ...current, accounts, mtimeMs: stat.mtimeMs, size: stat.size };
        return result;
      }),
  };
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  if (stored.startsWith('scrypt:')) {
    const [, salt, hash] = stored.split(':');
    const expected = Buffer.from(hash, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  }
  // Clear-text password: compare digests so lengths always match.
  const a = crypto.createHash('sha256').update(password).digest();
  const b = crypto.createHash('sha256').update(stored).digest();
  return crypto.timingSafeEqual(a, b);
}

export async function authenticate(store, username, password) {
  const accounts = await store.read();
  const account = accounts.find((a) => a.username === username);
  // Hash anyway on unknown users so response time doesn't reveal which usernames exist.
  const ok = verifyPassword(password ?? '', account ? account.password : hashPassword('dummy'));
  return account && ok ? account.username : null;
}
