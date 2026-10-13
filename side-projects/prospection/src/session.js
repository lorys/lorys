// Sessions sans état : le cookie contient "<expiration>.<hmac>". Changer PASSWORD invalide tous les jetons.
import crypto from 'node:crypto';

export const SESSION_COOKIE = 'session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // un mois

function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function createSessionToken(secret, now = Date.now()) {
  const expiry = String(now + SESSION_TTL_MS);
  return `${expiry}.${sign(expiry, secret)}`;
}

export function isValidSessionToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string') return false;
  const [expiry, signature, ...rest] = token.split('.');
  if (!expiry || !signature || rest.length) return false;
  const expected = Buffer.from(sign(expiry, secret));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
  return Number(expiry) > now;
}

export function checkPassword(candidate, password) {
  const hash = (value) => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(hash(candidate), hash(password));
}
