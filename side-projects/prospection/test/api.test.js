// Test d'intégration : nécessite une base MongoDB jetable dans TEST_MONGODB_URI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connectDb } from '../src/db.js';
import { buildApp } from '../src/app.js';

const uri = process.env.TEST_MONGODB_URI;

test('parcours complet de l\'API', { skip: !uri && 'TEST_MONGODB_URI non défini' }, async (t) => {
  const { client, db } = await connectDb(uri);
  await db.dropDatabase();
  const app = buildApp({ password: 'secret' }, db, { logger: false, resolveAddress: async () => '1 Rue Test, Paris' });
  t.after(async () => {
    await app.close();
    await db.dropDatabase();
    await client.close();
  });

  assert.equal((await app.inject({ method: 'GET', url: '/api/targets' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'non' } })).statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'secret' } });
  assert.equal(login.statusCode, 200);
  const cookie = login.cookies.find((c) => c.name === 'session');
  assert.equal(cookie.maxAge, 30 * 24 * 60 * 60);
  const headers = { cookie: `session=${cookie.value}` };
  const call = (method, url, payload) => app.inject({ method, url, payload, headers });

  const commercial = (await call('POST', '/api/commercials', { name: 'Alice' })).json();
  const created = await call('POST', '/api/targets', {
    name: 'Boulangerie', mapsUrl: 'https://maps.app.goo.gl/x', commercialId: commercial.id, nextDate: '2026-10-20',
  });
  assert.equal(created.statusCode, 201);
  const target = created.json();
  assert.equal(target.address, '1 Rue Test, Paris');
  assert.equal(target.status, 'a_demarcher');

  const noted = (await call('POST', `/api/targets/${target.id}/notes`, {
    date: '2026-10-10', text: '1er échange', nextDate: '2026-10-25',
  })).json();
  assert.equal(noted.notes.length, 1);
  assert.equal(noted.status, 'en_cours');
  assert.equal(noted.nextDate, '2026-10-25');
  assert.ok(noted.startedAt);
  assert.equal(target.startedAt, null);

  assert.equal((await call('POST', '/api/targets', { name: '' })).statusCode, 400);
  assert.equal((await call('DELETE', `/api/commercials/${commercial.id}`)).statusCode, 200);
  const [after] = (await call('GET', '/api/targets')).json();
  assert.equal(after.commercialId, null);
  const removed = (await call('DELETE', `/api/targets/${target.id}/notes/${noted.notes[0].id}`)).json();
  assert.equal(removed.notes.length, 0);
});
