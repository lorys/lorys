import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createAccountsStore,
  decryptAccounts,
  encryptAccounts,
  hashPassword,
  readAccounts,
  verifyPassword,
  writeAccounts,
} from '../src/accounts.js';
import { createSessionToken, readSessionToken } from '../src/session.js';
import { parseMovieFilename } from '../src/filename.js';
import { readMoviesInfos, scanMovies } from '../src/scanner.js';
import { needsScan } from '../src/watcher.js';
import { buildApp, isFinished, parseRange } from '../src/app.js';
import { pickFilename } from '../src/downloads.js';

test('accounts round-trip through encryption and reject a wrong secret', () => {
  const accounts = [{ username: 'lorys', password: 'secret' }];
  const payload = encryptAccounts(accounts, 'key');
  assert.ok(!payload.includes('lorys'));
  assert.deepEqual(decryptAccounts(payload, 'key'), accounts);
  assert.throws(() => decryptAccounts(payload, 'wrong'), /Unable to decrypt/);
});

test('verifyPassword handles hashed and clear passwords', () => {
  assert.ok(verifyPassword('pw', hashPassword('pw')));
  assert.ok(!verifyPassword('nope', hashPassword('pw')));
  assert.ok(verifyPassword('pw', 'pw'));
  assert.ok(!verifyPassword('pw', 'pw2'));
});

test('session tokens are signed and expire', () => {
  const token = createSessionToken('lorys', 's', 0);
  assert.equal(readSessionToken(token, 's', 1000), 'lorys');
  assert.equal(readSessionToken(token, 'other', 1000), null);
  assert.equal(readSessionToken(token.replace(/^[^.]+/, 'YWRtaW4'), 's', 1000), null);
  assert.equal(readSessionToken(token, 's', Number.MAX_SAFE_INTEGER), null);
});

test('parseMovieFilename extracts title and year', () => {
  assert.deepEqual(parseMovieFilename('Le.Fabuleux.Destin.d\'Amelie.Poulain.2001.1080p.BluRay.x264.mkv'), {
    title: "Le Fabuleux Destin d'Amelie Poulain",
    year: 2001,
  });
  assert.deepEqual(parseMovieFilename('Intouchables (2011) [MULTI].mp4'), { title: 'Intouchables', year: 2011 });
  assert.deepEqual(parseMovieFilename('2001 A Space Odyssey 1968.mkv'), { title: '2001 A Space Odyssey', year: 1968 });
  assert.deepEqual(parseMovieFilename('La_Haine_FRENCH_DVDRip.avi'), { title: 'La Haine', year: null });
  assert.deepEqual(parseMovieFilename('films/Drame/Amour.mp4'), { title: 'Amour', year: null });
});

test('isFinished once only the credits are left', () => {
  assert.equal(isFinished(100, 7200), false);
  assert.equal(isFinished(6900, 7200), true); // last 5%
  assert.equal(isFinished(560, 600), true); // last minute of a short video
});

test('parseRange', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=0-5000', 1000), { start: 0, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), null);
  assert.equal(parseRange('items=0-1', 1000), null);
});

// ---------- Scanner, watcher and HTTP API against a temp directory ----------

let dir;
let config;
const fakeTmdb = {
  calls: 0,
  async searchMovie(title) {
    this.calls++;
    return title === 'Inconnu' ? null : { id: title.length };
  },
  async movieDetails(id) {
    return {
      id,
      title: `Film ${id}`,
      original_title: `Movie ${id}`,
      overview: 'Résumé',
      release_date: '2001-04-25',
      runtime: 120,
      genres: [{ name: 'Comédie' }],
      vote_average: 7.5,
      poster_path: '/p.jpg',
      backdrop_path: '/b.jpg',
      credits: { crew: [{ job: 'Director', name: 'Réal' }], cast: [{ name: 'Acteur' }] },
    };
  },
};
const quiet = { warn() {}, error() {}, info() {} };

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'netflix-test-'));
  await fs.mkdir(path.join(dir, 'movies', 'sub'), { recursive: true });
  await fs.writeFile(path.join(dir, 'movies', 'Amelie.2001.mp4'), Buffer.alloc(1000, 1));
  await fs.writeFile(path.join(dir, 'movies', 'sub', 'Inconnu.mkv'), 'x');
  await fs.writeFile(path.join(dir, 'movies', 'notes.txt'), 'ignored');
  config = {
    moviesPath: path.join(dir, 'movies'),
    moviesInfosPath: path.join(dir, 'infos', 'movies.json'),
    accountsPath: path.join(dir, 'accounts.enc'),
    accountsSecret: 'secret',
    sessionSecret: 'session-secret',
  };
  await writeAccounts(config.accountsPath, [{ username: 'lorys', password: hashPassword('pw') }], config.accountsSecret);
});

after(() => fs.rm(dir, { recursive: true, force: true }));

test('scanMovies writes infos and only looks up new or unmatched files', async () => {
  assert.equal(await needsScan(config), true);

  const stats = await scanMovies(config, { tmdb: fakeTmdb, logger: quiet });
  assert.equal(stats.total, 2);
  assert.equal(stats.matched, 1);
  assert.equal(stats.unmatched, 1);

  const { movies } = await readMoviesInfos(config.moviesInfosPath);
  const amelie = movies.find((m) => m.file === 'Amelie.2001.mp4');
  assert.equal(amelie.title, 'Film 6');
  assert.deepEqual(amelie.genres, ['Comédie']);
  assert.equal(amelie.director, 'Réal');
  assert.equal(movies.find((m) => m.file === 'sub/Inconnu.mkv').matched, false);

  assert.equal(await needsScan(config), false);

  fakeTmdb.calls = 0;
  await scanMovies(config, { tmdb: fakeTmdb, logger: quiet });
  assert.equal(fakeTmdb.calls, 1, 'only the unmatched file is looked up again');
});

test('needsScan detects added and removed movies', async () => {
  await fs.writeFile(path.join(config.moviesPath, 'Nouveau.mp4'), 'x');
  assert.equal(await needsScan(config), true);
  await scanMovies(config, { tmdb: fakeTmdb, logger: quiet });
  assert.equal(await needsScan(config), false);

  await fs.rm(path.join(config.moviesPath, 'Nouveau.mp4'));
  assert.equal(await needsScan(config), true);
  await scanMovies(config, { tmdb: fakeTmdb, logger: quiet });
  const { movies } = await readMoviesInfos(config.moviesInfosPath);
  assert.equal(movies.length, 2);
});

test('HTTP API: auth, movie list and ranged streaming', async () => {
  const app = buildApp(config, { logger: false });
  try {
    assert.equal((await app.inject('/api/movies')).statusCode, 401);

    const bad = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'lorys', password: 'x' } });
    assert.equal(bad.statusCode, 401);

    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'lorys', password: 'pw' } });
    assert.equal(login.statusCode, 200);
    const cookie = login.cookies.find((c) => c.name === 'session');
    const cookies = { session: cookie.value };

    const list = await app.inject({ url: '/api/movies', cookies });
    const { movies } = list.json();
    assert.equal(movies.length, 2);
    assert.equal(movies[0].parsed, undefined);

    const amelie = movies.find((m) => m.file === 'Amelie.2001.mp4');
    const full = await app.inject({ url: `/api/movies/${amelie.id}/stream`, cookies });
    assert.equal(full.statusCode, 200);
    assert.equal(full.rawPayload.length, 1000);
    assert.equal(full.headers['content-type'], 'video/mp4');

    const partial = await app.inject({ url: `/api/movies/${amelie.id}/stream`, cookies, headers: { range: 'bytes=10-19' } });
    assert.equal(partial.statusCode, 206);
    assert.equal(partial.headers['content-range'], 'bytes 10-19/1000');
    assert.equal(partial.rawPayload.length, 10);

    assert.equal((await app.inject({ url: '/api/movies/nope/stream', cookies })).statusCode, 404);
    assert.equal((await app.inject('/')).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('accounts store persists updates and picks up external edits', async () => {
  const file = path.join(dir, 'store.enc');
  const store = createAccountsStore(file, 'secret');
  assert.deepEqual(await store.read(), []);

  await store.update((list) => list.push({ username: 'a', password: 'x' }));
  assert.deepEqual(await readAccounts(file, 'secret'), [{ username: 'a', password: 'x' }]);

  // Simulate the accounts CLI rewriting the file behind the server's back.
  await writeAccounts(file, [{ username: 'a', password: 'x' }, { username: 'b', password: 'y' }], 'secret');
  await store.update((list) => {
    list.find((a) => a.username === 'a').progress = { abc: 1 };
  });
  const saved = await readAccounts(file, 'secret');
  assert.deepEqual(saved.map((a) => a.username), ['a', 'b'], 'external change is kept');
  assert.deepEqual(saved[0].progress, { abc: 1 });

  // A failing mutation leaves the file untouched and doesn't block the queue.
  await assert.rejects(store.update(() => {
    throw new Error('boom');
  }));
  assert.equal((await store.read()).length, 2);
});

test('HTTP API: watch progress is stored in the accounts file', async () => {
  const app = buildApp(config, { logger: false });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'lorys', password: 'pw' } });
    const cookies = { session: login.cookies.find((c) => c.name === 'session').value };
    const { movies } = (await app.inject({ url: '/api/movies', cookies })).json();
    const id = movies[0].id;

    assert.equal((await app.inject({ url: '/api/progress' })).statusCode, 401);
    assert.deepEqual((await app.inject({ url: '/api/progress', cookies })).json(), {});

    const put = await app.inject({ method: 'PUT', url: `/api/progress/${id}`, cookies, payload: { position: 1234.6, duration: 7200 } });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().progress.position, 1235);

    const list = (await app.inject({ url: '/api/progress', cookies })).json();
    assert.equal(list[id].position, 1235);
    assert.equal(list[id].duration, 7200);

    // Persisted, encrypted, next to the credentials.
    const [account] = await readAccounts(config.accountsPath, config.accountsSecret);
    assert.equal(account.progress[id].position, 1235);
    assert.ok(verifyPassword('pw', account.password));
    assert.ok(!(await fs.readFile(config.accountsPath, 'utf8')).includes('progress'));

    // Reaching the credits clears it.
    const done = await app.inject({ method: 'PUT', url: `/api/progress/${id}`, cookies, payload: { position: 7150, duration: 7200 } });
    assert.equal(done.json().progress, null);
    assert.deepEqual((await app.inject({ url: '/api/progress', cookies })).json(), {});

    // Restart clears it too.
    await app.inject({ method: 'PUT', url: `/api/progress/${id}`, cookies, payload: { position: 60, duration: 7200 } });
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/progress/${id}`, cookies })).statusCode, 200);
    assert.deepEqual((await app.inject({ url: '/api/progress', cookies })).json(), {});

    const unknown = await app.inject({ method: 'PUT', url: '/api/progress/000000000000', cookies, payload: { position: 1, duration: 2 } });
    assert.equal(unknown.statusCode, 404);
    const invalid = await app.inject({ method: 'PUT', url: `/api/progress/${id}`, cookies, payload: { position: -1, duration: 2 } });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('pickFilename prefers Content-Disposition, sanitizes, and rejects non-videos', () => {
  assert.equal(pickFilename({ disposition: 'attachment; filename="Amelie.2001.mkv"', url: 'https://x.test/dl?id=1' }), 'Amelie.2001.mkv');
  assert.equal(pickFilename({ disposition: "attachment; filename*=UTF-8''Am%C3%A9lie.mp4", url: 'https://x.test/a' }), 'Amélie.mp4');
  assert.equal(pickFilename({ url: 'https://x.test/films/La%20Haine.avi?token=1' }), 'La Haine.avi');
  assert.equal(pickFilename({ disposition: 'attachment; filename="../../etc/evil.mp4"', url: 'https://x.test/' }), 'evil.mp4');
  assert.equal(pickFilename({ url: 'https://x.test/watch', contentType: 'video/webm; codecs=vp9' }), 'watch.webm');
  assert.equal(pickFilename({ url: 'https://x.test/page.html', contentType: 'text/html' }), null);
});

test('HTTP API: downloads a movie into MOVIES_PATH with progress', async () => {
  const http = await import('node:http');
  const body = Buffer.alloc(200_000, 7);
  const server = http.createServer((req, res) => {
    if (req.url === '/Telecharge.2020.mp4') {
      res.writeHead(200, { 'content-length': body.length, 'content-type': 'video/mp4' });
      res.end(body);
    } else if (req.url === '/slow.mp4') {
      res.writeHead(200, { 'content-length': body.length });
      res.write(body.subarray(0, 1000)); // never finishes
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const app = buildApp(config, { logger: false });
  const waitFor = async (cookies, id, status) => {
    for (let i = 0; i < 200; i++) {
      const found = (await app.inject({ url: '/api/downloads', cookies })).json().find((d) => d.id === id);
      if (found.status === status) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`download never reached ${status}`);
  };
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/downloads', payload: { url: base } })).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'lorys', password: 'pw' } });
    const cookies = { session: login.cookies.find((c) => c.name === 'session').value };

    const invalid = await app.inject({ method: 'POST', url: '/api/downloads', cookies, payload: { url: 'file:///etc/passwd' } });
    assert.equal(invalid.statusCode, 400);

    // Two downloads in parallel: one completes, one hangs and gets cancelled.
    const ok = (await app.inject({ method: 'POST', url: '/api/downloads', cookies, payload: { url: `${base}/Telecharge.2020.mp4` } })).json();
    const slow = (await app.inject({ method: 'POST', url: '/api/downloads', cookies, payload: { url: `${base}/slow.mp4` } })).json();
    assert.equal(ok.status, 'downloading');

    const done = await waitFor(cookies, ok.id, 'done');
    assert.equal(done.filename, 'Telecharge.2020.mp4');
    assert.equal(done.received, body.length);
    assert.equal(done.total, body.length);
    assert.deepEqual(await fs.readFile(path.join(config.moviesPath, 'Telecharge.2020.mp4')), body);

    const running = (await app.inject({ url: '/api/downloads', cookies })).json().find((d) => d.id === slow.id);
    assert.equal(running.status, 'downloading');
    assert.ok(await fs.stat(path.join(config.moviesPath, 'slow.mp4.part')));
    assert.equal(await needsScan(config), true, 'the finished file is picked up');
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/downloads/${slow.id}`, cookies })).statusCode, 200);
    await waitFor(cookies, slow.id, 'cancelled');
    await assert.rejects(fs.stat(path.join(config.moviesPath, 'slow.mp4.part')), 'partial file removed');

    // Same name again gets a suffix; non-video links fail.
    const again = (await app.inject({ method: 'POST', url: '/api/downloads', cookies, payload: { url: `${base}/Telecharge.2020.mp4` } })).json();
    assert.equal((await waitFor(cookies, again.id, 'done')).filename, 'Telecharge.2020 (1).mp4');
    const html = (await app.inject({ method: 'POST', url: '/api/downloads', cookies, payload: { url: `${base}/page` } })).json();
    assert.match((await waitFor(cookies, html.id, 'error')).error, /vidéo/);

    // Finished downloads can be dismissed.
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/downloads/${ok.id}`, cookies })).statusCode, 200);
    assert.ok(!(await app.inject({ url: '/api/downloads', cookies })).json().some((d) => d.id === ok.id));
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/downloads/${ok.id}`, cookies })).statusCode, 404);
  } finally {
    await app.close();
    server.closeAllConnections();
    server.close();
    await fs.rm(path.join(config.moviesPath, 'Telecharge.2020.mp4'), { force: true });
    await fs.rm(path.join(config.moviesPath, 'Telecharge.2020 (1).mp4'), { force: true });
  }
});

test('HTTP API: conversion status and blocked streaming', async () => {
  const statuses = new Map();
  const fakeConversions = {
    status: (id) => statuses.get(id) ?? null,
    list: () => Object.fromEntries(statuses),
    isBusy: (id) => ['queued', 'converting'].includes(statuses.get(id)?.status),
    close: async () => {},
  };
  const app = buildApp(config, { logger: false, conversions: fakeConversions });
  try {
    assert.equal((await app.inject('/api/conversions')).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'lorys', password: 'pw' } });
    const cookies = { session: login.cookies.find((c) => c.name === 'session').value };
    const { movies } = (await app.inject({ url: '/api/movies', cookies })).json();
    const amelie = movies.find((m) => m.file === 'Amelie.2001.mp4');
    assert.equal(amelie.conversion, undefined);

    statuses.set(amelie.id, { status: 'converting', percent: 42, error: null });
    const listed = (await app.inject({ url: '/api/movies', cookies })).json().movies.find((m) => m.id === amelie.id);
    assert.deepEqual(listed.conversion, { status: 'converting', percent: 42, error: null });
    assert.deepEqual((await app.inject({ url: '/api/conversions', cookies })).json(), {
      [amelie.id]: { status: 'converting', percent: 42, error: null },
    });
    const blocked = await app.inject({ url: `/api/movies/${amelie.id}/stream`, cookies });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().error, 'Conversion en cours');

    // A failed conversion leaves the original playable.
    statuses.set(amelie.id, { status: 'failed', percent: 0, error: 'boom' });
    assert.equal((await app.inject({ url: `/api/movies/${amelie.id}/stream`, cookies })).statusCode, 200);
  } finally {
    await app.close();
  }
});
