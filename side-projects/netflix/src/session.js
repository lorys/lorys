// Stateless sessions: the cookie holds "<base64url username>.<expiry>.<hmac>".
import crypto from 'node:crypto';

export const SESSION_COOKIE = 'session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function createSessionToken(username, secret, now = Date.now()) {
  const data = `${Buffer.from(username).toString('base64url')}.${now + SESSION_TTL_MS}`;
  return `${data}.${sign(data, secret)}`;
}

export function readSessionToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [user, expiry, signature] = parts;
  const expected = Buffer.from(sign(`${user}.${expiry}`, secret));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  if (!(Number(expiry) > now)) return null;
  return Buffer.from(user, 'base64url').toString('utf8');
}
