import test from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_TTL_MS, checkPassword, createSessionToken, isValidSessionToken } from '../src/session.js';

test('un jeton est valide pendant un mois', () => {
  const now = 1_000_000;
  const token = createSessionToken('secret', now);
  assert.equal(isValidSessionToken(token, 'secret', now + SESSION_TTL_MS - 1), true);
  assert.equal(isValidSessionToken(token, 'secret', now + SESSION_TTL_MS), false);
});

test('un jeton signé avec un autre secret ou modifié est refusé', () => {
  const token = createSessionToken('secret');
  assert.equal(isValidSessionToken(token, 'autre'), false);
  assert.equal(isValidSessionToken(`9${token}`, 'secret'), false);
  assert.equal(isValidSessionToken(undefined, 'secret'), false);
});

test('checkPassword compare le mot de passe', () => {
  assert.equal(checkPassword('abc', 'abc'), true);
  assert.equal(checkPassword('abd', 'abc'), false);
});
