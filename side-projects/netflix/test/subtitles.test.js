import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { hashPassword, writeAccounts } from '../src/accounts.js';
import { scanMovies } from '../src/scanner.js';
import { buildApp } from '../src/app.js';
import { decodeSubtitle, describeSubtitle, findSidecarSubtitles, srtToVtt, subtitleLabel } from '../src/subtitles.js';

const run = promisify(execFile);
const hasFfmpeg = await run('ffmpeg', ['-version']).then(() => true, () => false);

const SRT = '1\r\n00:00:01,000 --> 00:00:02,500\r\n<font color="#fff">Bonjour</font> {\\an8}à tous\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n<i>Salut</i>\r\n';

test('srtToVtt converts timestamps and strips SubRip-only markup', () => {
  assert.equal(
    srtToVtt(SRT),
    'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nBonjour à tous\n\n2\n00:00:03.000 --> 00:00:04.000\n<i>Salut</i>\n',
  );
});

test('srtToVtt stays fast on unclosed tags', () => {
  const start = Date.now();
  srtToVtt('<font'.repeat(200_000) + '{\\'.repeat(200_000));
  assert.ok(Date.now() - start < 1000);
});

test('decodeSubtitle handles UTF-8 with BOM and Windows-1252 files', () => {
  assert.equal(decodeSubtitle(Buffer.from('﻿Été', 'utf8')), 'Été');
  assert.equal(decodeSubtitle(Buffer.from([0xc9, 0x74, 0xe9])), 'Été');
});

test('describeSubtitle and subtitleLabel read languages and flags', () => {
  assert.deepEqual(describeSubtitle(['fr']), { lang: 'fr', forced: false, sdh: false });
  assert.deepEqual(describeSubtitle(['English', 'SDH']), { lang: 'en', forced: false, sdh: true });
  assert.deepEqual(describeSubtitle(['fre', 'forced']), { lang: 'fr', forced: true, sdh: false });
  assert.equal(subtitleLabel({ lang: 'fr', forced: true }), 'Français (forcés)');
  assert.equal(subtitleLabel({ lang: 'en', sdh: true }), 'Anglais [CC]');
  assert.equal(subtitleLabel({ lang: null, title: '' }), 'Sous-titres');
});

let dir;
let config;
const quiet = { warn() {}, error() {}, info() {} };
const fakeTmdb = { searchMovie: async () => null, movieDetails: async () => null };

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'netflix-subs-'));
  const movies = path.join(dir, 'movies');
  await fs.mkdir(path.join(movies, 'Solo', 'Subs'), { recursive: true });
  await fs.mkdir(path.join(movies, 'Pair'), { recursive: true });
  // Alone in its folder: every subtitle file around it belongs to it.
  await fs.writeFile(path.join(movies, 'Solo', 'Solo.2020.mp4'), 'x');
  await fs.writeFile(path.join(movies, 'Solo', 'Subs', '2_French.srt'), SRT);
  await fs.writeFile(path.join(movies, 'Solo', 'Subs', '3_English.srt'), SRT);
  // Two movies side by side: only files named after the video match.
  await fs.writeFile(path.join(movies, 'Pair', 'A.mp4'), 'x');
  await fs.writeFile(path.join(movies, 'Pair', 'B.mp4'), 'x');
  await fs.writeFile(path.join(movies, 'Pair', 'A.fr.srt'), SRT);
  await fs.writeFile(path.join(movies, 'Pair', 'A.en.forced.vtt'), 'WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n');
  await fs.writeFile(path.join(movies, 'Pair', 'B.srt'), SRT);
  if (hasFfmpeg) {
    await fs.writeFile(path.join(dir, 'embedded.srt'), SRT);
    await run('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x36:d=5', '-i', path.join(dir, 'embedded.srt'),
      '-map', '0', '-map', '1', '-c:v', 'libx264', '-c:s', 'srt', '-metadata:s:s:0', 'language=spa',
      path.join(movies, 'Embedded.mkv'),
    ]);
  }
  config = {
    moviesPath: movies,
    moviesInfosPath: path.join(dir, 'data', 'movies.json'),
    accountsPath: path.join(dir, 'accounts.enc'),
    accountsSecret: 'secret',
    sessionSecret: 'session-secret',
  };
  await writeAccounts(config.accountsPath, [{ username: 'lorys', password: await hashPassword('pw') }], config.accountsSecret);
  await scanMovies(config, { tmdb: fakeTmdb, logger: quiet });
});

after(() => fs.rm(dir, { recursive: true, force: true }));

test('findSidecarSubtitles matches files to their video', async () => {
  const solo = await findSidecarSubtitles(config.moviesPath, 'Solo/Solo.2020.mp4');
  assert.deepEqual(solo.map((s) => s.lang), ['fr', 'en']);

  const a = await findSidecarSubtitles(config.moviesPath, 'Pair/A.mp4');
  assert.deepEqual(a.map((s) => [path.basename(s.path), s.lang, s.forced]), [
    ['A.en.forced.vtt', 'en', true],
    ['A.fr.srt', 'fr', false],
  ]);
  const b = await findSidecarSubtitles(config.moviesPath, 'Pair/B.mp4');
  assert.deepEqual(b.map((s) => [path.basename(s.path), s.lang]), [['B.srt', null]]);
});

test('HTTP API: lists and serves subtitles as WebVTT', async () => {
  const app = buildApp(config, { logger: false });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'lorys', password: 'pw' } });
    const cookies = { session: login.cookies.find((c) => c.name === 'session').value };
    const { movies } = (await app.inject({ url: '/api/movies', cookies })).json();
    const a = movies.find((m) => m.file === 'Pair/A.mp4');

    assert.equal((await app.inject({ url: `/api/movies/${a.id}/subtitles` })).statusCode, 401);
    const list = (await app.inject({ url: `/api/movies/${a.id}/subtitles`, cookies })).json();
    assert.deepEqual(list, [
      { id: 'f0', lang: 'en', forced: true, label: 'Anglais (forcés)' },
      { id: 'f1', lang: 'fr', forced: false, label: 'Français' },
    ]);

    const vtt = await app.inject({ url: `/api/movies/${a.id}/subtitles/f1`, cookies });
    assert.equal(vtt.statusCode, 200);
    assert.match(vtt.headers['content-type'], /^text\/vtt/);
    assert.match(vtt.body, /^WEBVTT\n\n1\n00:00:01\.000 --> 00:00:02\.500/);

    assert.equal((await app.inject({ url: `/api/movies/${a.id}/subtitles/f9`, cookies })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/movies/nope/subtitles', cookies })).statusCode, 404);

    if (hasFfmpeg) {
      const embedded = movies.find((m) => m.file === 'Embedded.mkv');
      const tracks = (await app.inject({ url: `/api/movies/${embedded.id}/subtitles`, cookies })).json();
      assert.deepEqual(tracks, [{ id: 'e1', lang: 'es', forced: false, label: 'Espagnol' }]);
      const extracted = await app.inject({ url: `/api/movies/${embedded.id}/subtitles/e1`, cookies });
      assert.match(extracted.body, /^WEBVTT/);
      assert.match(extracted.body, /Bonjour/);
      const cache = await fs.readdir(path.join(dir, 'data', 'subtitles'));
      assert.equal(cache.length, 1, 'extracted track is cached next to MOVIES_INFOS_PATH');
    }
  } finally {
    await app.close();
  }
});
