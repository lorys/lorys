import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseEpisodeFilename, parseMovieFilename, showKey } from '../src/filename.js';
import { createTmdbClient } from '../src/tmdb.js';
import { readMoviesInfos, renameMovieEntry, scanMovies } from '../src/scanner.js';

const ep = (showTitle, season, episode, extra = {}) => ({ showTitle, year: null, season, episode, episodeEnd: episode, ...extra });

test('parseEpisodeFilename reads SxxEyy and NxNN markers', () => {
  assert.deepEqual(parseEpisodeFilename('Breaking.Bad.S01E02.1080p.WEB.x264.mkv'), ep('Breaking Bad', 1, 2));
  assert.deepEqual(parseEpisodeFilename('breaking bad s1e2.mp4'), ep('breaking bad', 1, 2));
  assert.deepEqual(parseEpisodeFilename('Show S01 E02.mkv'), ep('Show', 1, 2));
  assert.deepEqual(parseEpisodeFilename('Lupin.2x05.FRENCH.720p.mkv'), ep('Lupin', 2, 5));
  assert.deepEqual(parseEpisodeFilename('Le.Bureau.des.Legendes.S05E10.MULTi.1080p.mkv'), ep('Le Bureau des Legendes', 5, 10));
  assert.deepEqual(parseEpisodeFilename('[Grp] Show - S01E03 [1080p].mkv'), ep('Show', 1, 3));
  assert.deepEqual(parseEpisodeFilename('series/Breaking.Bad.S01E02.mkv'), ep('Breaking Bad', 1, 2), 'folders are ignored');
});

test('parseEpisodeFilename handles multi-episode files', () => {
  assert.deepEqual(parseEpisodeFilename('The.Office.US.S03E01E02.mkv'), ep('The Office US', 3, 1, { episodeEnd: 2 }));
  assert.deepEqual(parseEpisodeFilename('Show.S01E01-E02.mkv'), ep('Show', 1, 1, { episodeEnd: 2 }));
  assert.deepEqual(parseEpisodeFilename('Show.S01E01-02.1080p.mkv'), ep('Show', 1, 1, { episodeEnd: 2 }));
  assert.deepEqual(parseEpisodeFilename('Show.S01E01-1080p.mkv'), ep('Show', 1, 1), 'a resolution is not an episode');
  assert.deepEqual(parseEpisodeFilename('Show.S01E05-02.mkv'), ep('Show', 1, 5), 'a lower end is ignored');
});

test('parseEpisodeFilename uses a year before the marker as a hint', () => {
  assert.deepEqual(parseEpisodeFilename('Doctor.Who.2005.S01E01.mkv'), ep('Doctor Who', 1, 1, { year: 2005 }));
  assert.deepEqual(parseEpisodeFilename('Doctor Who (2005) - S01E01 - Rose.mkv'), ep('Doctor Who', 1, 1, { year: 2005 }));
  assert.deepEqual(parseEpisodeFilename('1923.S01E01.mkv'), ep('1923', 1, 1), 'a year-like show title is kept');
});

test('parseEpisodeFilename leaves movies alone', () => {
  for (const file of [
    'Apollo.13.1995.mkv',
    'Ocean.s.11.2001.mkv',
    'Movie.1920x1080.mkv',
    '2001 A Space Odyssey 1968.mkv',
    'Se7en.1995.mkv',
    'Le.Fabuleux.Destin.d\'Amelie.Poulain.2001.1080p.BluRay.x264.mkv',
    'S01E02.mkv', // no show name: nothing to group it with
  ]) {
    assert.equal(parseEpisodeFilename(file), null, file);
  }
  assert.deepEqual(parseMovieFilename('Intouchables (2011) [MULTI].mp4'), { title: 'Intouchables', year: 2011 });
});

test('showKey ignores case, accents and punctuation', () => {
  assert.equal(showKey('Breaking Bad'), 'breaking bad');
  assert.equal(showKey('breaking  bad'), 'breaking bad');
  assert.equal(showKey('Le Bureau des Légendes'), 'le bureau des legendes');
  assert.equal(showKey('The Office (US)'), 'the office us');
});

test('TMDB client searches TV shows (year hint, then without) and fetches seasons in French', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const searching = url.pathname.endsWith('/search/tv');
    // Nothing with the year hint, a hit without it.
    const results = url.searchParams.has('first_air_date_year') ? [] : [{ id: 1396 }];
    return { ok: true, status: 200, json: async () => (searching ? { results } : { id: 1396 }) };
  };
  const client = createTmdbClient('v3key', { fetchImpl });

  assert.deepEqual(await client.searchTv('Breaking Bad', 2008), { id: 1396 });
  assert.equal(urls[0].pathname, '/3/search/tv');
  assert.equal(urls[0].searchParams.get('query'), 'Breaking Bad');
  assert.equal(urls[0].searchParams.get('first_air_date_year'), '2008');
  assert.equal(urls[0].searchParams.get('language'), 'fr-FR');
  assert.equal(urls[1].searchParams.has('first_air_date_year'), false);

  await client.tvDetails(1396);
  assert.equal(urls[2].pathname, '/3/tv/1396');
  await client.seasonDetails(1396, 2);
  assert.equal(urls[3].pathname, '/3/tv/1396/season/2');
  assert.equal(urls[3].searchParams.get('language'), 'fr-FR');
});

// ---------- Scanner ----------

const quiet = { warn() {}, error() {}, info() {} };
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'netflix-series-'));
after(() => fs.rm(tmpRoot, { recursive: true, force: true }));

async function library(name, files) {
  const config = {
    moviesPath: path.join(tmpRoot, name, 'movies'),
    moviesInfosPath: path.join(tmpRoot, name, 'movies.json'),
    accountsPath: path.join(tmpRoot, name, 'accounts.enc'),
    accountsSecret: 'secret',
    sessionSecret: 'session-secret',
  };
  await fs.mkdir(config.moviesPath, { recursive: true });
  for (const file of files) await fs.writeFile(path.join(config.moviesPath, file), 'x');
  return config;
}

function fakeTmdb({ failShow = null, failSeason = null } = {}) {
  return {
    calls: [],
    async searchMovie(title) {
      this.calls.push(['searchMovie', title]);
      return { id: 7 };
    },
    async movieDetails(id) {
      return { id, title: 'Un film', original_title: 'A movie', genres: [{ name: 'Drame' }], credits: {} };
    },
    async searchTv(title, year) {
      this.calls.push(['searchTv', title, year]);
      if (title === failShow) throw new Error('TMDB down');
      return title === 'Inconnue' ? null : { id: 100 };
    },
    async tvDetails(id) {
      this.calls.push(['tvDetails', id]);
      return {
        id,
        name: 'Breaking Bad',
        original_name: 'Breaking Bad',
        overview: 'Un prof de chimie…',
        poster_path: '/bb.jpg',
        backdrop_path: '/bbb.jpg',
        genres: [{ name: 'Drame' }],
        vote_average: 8.9,
        first_air_date: '2008-01-20',
      };
    },
    async seasonDetails(id, season) {
      this.calls.push(['seasonDetails', id, season]);
      if (season === failSeason) throw new Error('TMDB down');
      return {
        episodes: [1, 2, 3].map((n) => ({
          episode_number: n,
          name: `S${season} épisode ${n}`,
          overview: `Résumé ${n}`,
          still_path: `/s${season}e${n}.jpg`,
          runtime: 47,
          air_date: '2008-01-27',
        })),
      };
    },
  };
}

const callsOf = (tmdb, name) => tmdb.calls.filter((c) => c[0] === name);

test('scanMovies groups episodes into shows with one lookup per show and season', async () => {
  const config = await library('grouping', [
    'Breaking.Bad.S01E01.1080p.mkv',
    'Breaking.Bad.S01E02.1080p.mkv',
    'breaking.bad.s02e01.mkv',
    'Inconnue.S01E01.mkv',
    'Film.2001.mp4',
  ]);
  const tmdb = fakeTmdb();
  const stats = await scanMovies(config, { tmdb, logger: quiet });

  assert.equal(stats.total, 5);
  assert.equal(stats.shows, 2);
  assert.equal(stats.matched, 4);
  assert.equal(stats.unmatched, 1);
  assert.equal(callsOf(tmdb, 'searchTv').length, 2);
  assert.equal(callsOf(tmdb, 'tvDetails').length, 1);
  assert.deepEqual(callsOf(tmdb, 'seasonDetails').map((c) => c[2]).sort(), [1, 2]);
  assert.deepEqual(callsOf(tmdb, 'searchMovie'), [['searchMovie', 'Film']]);

  const { movies, shows } = await readMoviesInfos(config.moviesInfosPath);
  const bb = shows['breaking bad'];
  assert.equal(bb.matched, true);
  assert.equal(bb.tmdbId, 100);
  assert.equal(bb.title, 'Breaking Bad');
  assert.equal(bb.firstAirYear, 2008);
  assert.deepEqual(bb.genres, ['Drame']);
  assert.deepEqual(Object.keys(bb.seasons).sort(), ['1', '2']);
  assert.equal(bb.seasons[1][2].name, 'S1 épisode 2');

  const e2 = movies.find((m) => m.file === 'Breaking.Bad.S01E02.1080p.mkv');
  assert.equal(e2.kind, 'episode');
  assert.equal(e2.showKey, 'breaking bad');
  assert.equal(e2.season, 1);
  assert.equal(e2.episode, 2);
  assert.equal(e2.episodeEnd, 2);
  assert.equal(e2.matched, true);
  assert.equal(e2.title, 'S1 épisode 2');
  assert.equal(e2.overview, 'Résumé 2');
  assert.equal(e2.stillPath, '/s1e2.jpg');
  assert.equal(e2.runtime, 47);
  assert.deepEqual(e2.genres, []);
  assert.deepEqual(e2.cast, []);

  const unknown = movies.find((m) => m.file === 'Inconnue.S01E01.mkv');
  assert.equal(unknown.kind, 'episode');
  assert.equal(unknown.matched, false);
  assert.equal(unknown.title, 'Épisode 1');
  assert.deepEqual(shows.inconnue, { ...shows.inconnue, matched: false, title: 'Inconnue', seasons: {} });

  const film = movies.find((m) => m.file === 'Film.2001.mp4');
  assert.equal(film.kind, undefined);
  assert.equal(film.title, 'Un film');
});

test('scanMovies rescans incrementally and drops shows and seasons without files', async () => {
  const config = await library('incremental', ['Breaking.Bad.S01E01.mkv', 'Inconnue.S01E01.mkv']);
  await scanMovies(config, { tmdb: fakeTmdb(), logger: quiet });

  let tmdb = fakeTmdb();
  await scanMovies(config, { tmdb, logger: quiet });
  assert.deepEqual(tmdb.calls, [['searchTv', 'Inconnue', null]], 'only the unmatched show is retried');

  // A new episode of a known season: no lookup. A new season: only that season.
  await fs.writeFile(path.join(config.moviesPath, 'Breaking.Bad.S01E02.mkv'), 'x');
  await fs.writeFile(path.join(config.moviesPath, 'Breaking.Bad.S03E01.mkv'), 'x');
  tmdb = fakeTmdb();
  await scanMovies(config, { tmdb, logger: quiet });
  assert.deepEqual(callsOf(tmdb, 'searchTv'), [['searchTv', 'Inconnue', null]]);
  assert.deepEqual(callsOf(tmdb, 'seasonDetails'), [['seasonDetails', 100, 3]]);
  let { movies, shows } = await readMoviesInfos(config.moviesInfosPath);
  assert.equal(movies.find((m) => m.file === 'Breaking.Bad.S01E02.mkv').title, 'S1 épisode 2');

  await fs.rm(path.join(config.moviesPath, 'Breaking.Bad.S03E01.mkv'));
  await fs.rm(path.join(config.moviesPath, 'Inconnue.S01E01.mkv'));
  await scanMovies(config, { tmdb: fakeTmdb(), logger: quiet });
  ({ movies, shows } = await readMoviesInfos(config.moviesInfosPath));
  assert.deepEqual(Object.keys(shows), ['breaking bad']);
  assert.deepEqual(Object.keys(shows['breaking bad'].seasons), ['1']);
});

test('scanMovies turns episodes matched as movies by older versions into episodes', async () => {
  const config = await library('migration', ['Lupin.S01E01.mkv']);
  await fs.writeFile(
    config.moviesInfosPath,
    JSON.stringify({
      updatedAt: null,
      movies: [{ id: 'abcdefabcdef', file: 'Lupin.S01E01.mkv', matched: true, title: 'Arsène Lupin (2004)', genres: ['Aventure'] }],
    }),
  );
  const tmdb = fakeTmdb();
  await scanMovies(config, { tmdb, logger: quiet });
  assert.equal(callsOf(tmdb, 'searchTv').length, 1);
  const { movies, shows } = await readMoviesInfos(config.moviesInfosPath);
  assert.equal(movies[0].id, 'abcdefabcdef', 'id (watch progress) is kept');
  assert.equal(movies[0].kind, 'episode');
  assert.deepEqual(movies[0].genres, []);
  assert.ok(shows.lupin);
});

test('a converted episode keeps its data and is not looked up again', async () => {
  const config = await library('converted', ['Breaking.Bad.S01E01.mkv']);
  await scanMovies(config, { tmdb: fakeTmdb(), logger: quiet });
  const before = (await readMoviesInfos(config.moviesInfosPath)).movies[0];

  await fs.rename(path.join(config.moviesPath, 'Breaking.Bad.S01E01.mkv'), path.join(config.moviesPath, 'Breaking.Bad.S01E01.mp4'));
  await renameMovieEntry(config, 'Breaking.Bad.S01E01.mkv', 'Breaking.Bad.S01E01.mp4');
  const tmdb = fakeTmdb();
  await scanMovies(config, { tmdb, logger: quiet });
  assert.deepEqual(tmdb.calls, []);
  const [after] = (await readMoviesInfos(config.moviesInfosPath)).movies;
  assert.equal(after.id, before.id);
  assert.equal(after.kind, 'episode');
  assert.equal(after.title, 'S1 épisode 1');
});

test('TMDB failures keep episodes visible and are retried on the next scan', async () => {
  const config = await library('failures', ['Panne.S01E01.mkv', 'Breaking.Bad.S04E01.mkv']);
  const stats = await scanMovies(config, { tmdb: fakeTmdb({ failShow: 'Panne', failSeason: 4 }), logger: quiet });
  assert.equal(stats.errors, 2);
  let { movies, shows } = await readMoviesInfos(config.moviesInfosPath);
  assert.equal(movies.length, 2);
  const s4 = movies.find((m) => m.file === 'Breaking.Bad.S04E01.mkv');
  assert.equal(s4.matched, false);
  assert.equal(s4.title, 'Épisode 1');
  assert.equal(shows['breaking bad'].matched, true);
  assert.equal(shows.panne.matched, false);

  const tmdb = fakeTmdb();
  await scanMovies(config, { tmdb, logger: quiet });
  // Season 4 of the known show, and season 1 of Panne now that the show is found.
  assert.deepEqual(callsOf(tmdb, 'seasonDetails').map((c) => c[2]).sort(), [1, 4]);
  assert.equal(callsOf(tmdb, 'tvDetails').length, 1, 'Breaking Bad itself is not looked up again');
  ({ movies } = await readMoviesInfos(config.moviesInfosPath));
  assert.equal(movies.find((m) => m.file === 'Breaking.Bad.S04E01.mkv').title, 'S4 épisode 1');
  assert.equal(movies.find((m) => m.file === 'Panne.S01E01.mkv').matched, true);
});

test('readMoviesInfos defaults shows for files written before series support', async () => {
  const config = await library('legacy', []);
  assert.deepEqual(await readMoviesInfos(config.moviesInfosPath), { updatedAt: null, movies: [], shows: {} });
  await fs.writeFile(config.moviesInfosPath, JSON.stringify({ updatedAt: 'x', movies: [] }));
  assert.deepEqual(await readMoviesInfos(config.moviesInfosPath), { updatedAt: 'x', movies: [], shows: {} });
});
