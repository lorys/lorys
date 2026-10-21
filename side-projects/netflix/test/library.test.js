import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashPassword, writeAccounts } from '../src/accounts.js';
import { readMoviesInfos, scanMovies } from '../src/scanner.js';
import { buildApp } from '../src/app.js';

// Fixing a TMDB match by name, and deleting movies and series (ADMIN only).

const quiet = { warn() {}, error() {}, info() {} };
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'netflix-library-'));
after(() => fs.rm(tmpRoot, { recursive: true, force: true }));

function fakeTmdb() {
  return {
    calls: [],
    async searchMovie(title, year) {
      this.calls.push(['searchMovie', title, year]);
      return title === 'Le Fabuleux Destin' ? { id: 1 } : null;
    },
    async movieDetails(id) {
      return { id, title: "Le Fabuleux Destin d'Amélie Poulain", original_title: 'Amélie', release_date: '2001-04-25', genres: [{ name: 'Comédie' }], credits: {} };
    },
    async searchTv(title, year) {
      this.calls.push(['searchTv', title, year]);
      return title === 'The Office' ? { id: 2 } : null;
    },
    async tvDetails(id) {
      return { id, name: 'The Office', original_name: 'The Office', genres: [{ name: 'Comédie' }], first_air_date: '2005-03-24' };
    },
    async seasonDetails(id, season) {
      this.calls.push(['seasonDetails', id, season]);
      return { episodes: [{ episode_number: 1, name: 'Pilote' }] };
    },
  };
}

async function setup(name) {
  const config = {
    moviesPath: path.join(tmpRoot, name, 'movies'),
    moviesInfosPath: path.join(tmpRoot, name, 'movies.json'),
    accountsPath: path.join(tmpRoot, name, 'accounts.enc'),
    accountsSecret: 'secret',
    sessionSecret: 'session-secret',
    admin: 'boss',
  };
  await fs.mkdir(path.join(config.moviesPath, 'Office'), { recursive: true });
  for (const file of ['Amelie.2001.mp4', 'Office/Bureau.S01E01.mkv', 'Office/Bureau.S01E02.mkv']) {
    await fs.writeFile(path.join(config.moviesPath, file), 'x');
  }
  await writeAccounts(
    config.accountsPath,
    [{ username: 'boss', password: await hashPassword('pw') }, { username: 'guest', password: await hashPassword('pw') }],
    config.accountsSecret,
  );
  await scanMovies(config, { tmdb: fakeTmdb(), logger: quiet });
  const tmdb = fakeTmdb();
  const app = buildApp(config, { logger: false, loginIntervalMs: 0, tmdb });
  const login = async (username) => {
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { username, password: 'pw' } });
    return { session: res.cookies.find((c) => c.name === 'session').value };
  };
  return { config, app, tmdb, login };
}

test('a movie TMDB missed is matched again by the name the admin types, and later scans keep that name', async () => {
  const { config, app, tmdb, login } = await setup('rematch-movie');
  try {
    const cookies = await login('boss');
    let { movies } = (await app.inject({ url: '/api/movies', cookies })).json();
    const amelie = movies.find((m) => m.file === 'Amelie.2001.mp4');
    assert.equal(amelie.matched, false);

    const guest = await login('guest');
    const refused = await app.inject({ method: 'POST', url: `/api/movies/${amelie.id}/match`, cookies: guest, payload: { name: 'Le Fabuleux Destin' } });
    assert.equal(refused.statusCode, 403);
    assert.deepEqual(tmdb.calls, [], 'no TMDB lookup for other users');

    const miss = await app.inject({ method: 'POST', url: `/api/movies/${amelie.id}/match`, cookies, payload: { name: 'Amélie' } });
    assert.equal(miss.statusCode, 404);
    assert.match(miss.json().error, /Amélie/);

    const hit = await app.inject({ method: 'POST', url: `/api/movies/${amelie.id}/match`, cookies, payload: { name: ' Le Fabuleux Destin ' } });
    assert.equal(hit.statusCode, 200);
    assert.equal(hit.json().title, "Le Fabuleux Destin d'Amélie Poulain");
    assert.deepEqual(tmdb.calls.at(-1), ['searchMovie', 'Le Fabuleux Destin', undefined], 'typed name, no year');

    ({ movies } = (await app.inject({ url: '/api/movies', cookies })).json());
    const updated = movies.find((m) => m.id === amelie.id);
    assert.equal(updated.matched, true);
    assert.equal(updated.searchName, 'Le Fabuleux Destin');

    const rescan = fakeTmdb();
    await scanMovies(config, { tmdb: rescan, logger: quiet, force: true });
    assert.ok(rescan.calls.some((c) => c[0] === 'searchMovie' && c[1] === 'Le Fabuleux Destin'));
    const { movies: after } = await readMoviesInfos(config.moviesInfosPath);
    assert.equal(after.find((m) => m.id === amelie.id).tmdbId, 1);

    assert.equal((await app.inject({ method: 'POST', url: '/api/movies/nope/match', cookies, payload: { name: 'x' } })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test('a show is matched again by name, with its episodes (admin only)', async () => {
  const { app, tmdb, login } = await setup('rematch-show');
  try {
    const guest = await login('guest');
    assert.equal((await app.inject({ method: 'POST', url: '/api/shows/bureau/match', cookies: guest, payload: { name: 'The Office' } })).statusCode, 403);
    const cookies = await login('boss');
    const res = await app.inject({ method: 'POST', url: `/api/shows/${encodeURIComponent('bureau')}/match`, cookies, payload: { name: 'The Office' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(tmdb.calls.filter((c) => c[0] === 'seasonDetails'), [['seasonDetails', 2, 1]]);

    const { movies, shows } = (await app.inject({ url: '/api/movies', cookies })).json();
    assert.equal(shows.bureau.title, 'The Office');
    assert.equal(shows.bureau.matched, true);
    const episodes = movies.filter((m) => m.showKey === 'bureau').sort((a, b) => a.episode - b.episode);
    assert.deepEqual(episodes.map((e) => e.title), ['Pilote', 'Épisode 2']);
  } finally {
    await app.close();
  }
});

test('only the ADMIN account deletes movies and series, files included', async () => {
  const { config, app, login } = await setup('delete');
  try {
    const guest = await login('guest');
    const boss = await login('boss');
    assert.equal((await app.inject({ url: '/api/me', cookies: guest })).json().admin, false);
    assert.equal((await app.inject({ url: '/api/me', cookies: boss })).json().admin, true);

    const { movies } = (await app.inject({ url: '/api/movies', cookies: boss })).json();
    const amelie = movies.find((m) => m.file === 'Amelie.2001.mp4');

    assert.equal((await app.inject({ method: 'DELETE', url: `/api/movies/${amelie.id}`, cookies: guest })).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/movies/${amelie.id}` })).statusCode, 401);
    await fs.access(path.join(config.moviesPath, 'Amelie.2001.mp4'));

    const res = await app.inject({ method: 'DELETE', url: `/api/movies/${amelie.id}`, cookies: boss });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { deleted: 1 });
    await assert.rejects(fs.access(path.join(config.moviesPath, 'Amelie.2001.mp4')));
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/movies/${amelie.id}`, cookies: boss })).statusCode, 404);

    assert.equal((await app.inject({ method: 'DELETE', url: '/api/shows/bureau', cookies: boss })).json().deleted, 2);
    await assert.rejects(fs.access(path.join(config.moviesPath, 'Office')), 'emptied folder is removed');
    await fs.access(config.moviesPath);

    const infos = await readMoviesInfos(config.moviesInfosPath);
    assert.deepEqual(infos.movies, []);
    assert.deepEqual(infos.shows, {});
  } finally {
    await app.close();
  }
});

test('nobody is admin when ADMIN is not set', async () => {
  const { config, app, login } = await setup('no-admin');
  try {
    config.admin = '';
    const boss = await login('boss');
    assert.equal((await app.inject({ url: '/api/me', cookies: boss })).json().admin, false);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/shows/bureau', cookies: boss })).statusCode, 403);
  } finally {
    await app.close();
  }
});
