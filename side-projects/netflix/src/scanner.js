import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseEpisodeFilename, parseMovieFilename, showKey, VIDEO_EXTENSIONS } from './filename.js';
import { createTmdbClient } from './tmdb.js';
import { log } from './log.js';

const CONCURRENCY = 4;

export function movieId(relativePath) {
  return crypto.createHash('sha1').update(relativePath).digest('hex').slice(0, 12);
}

async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) yield full;
  }
}

export async function listVideoFiles(moviesPath) {
  const files = [];
  for await (const full of walk(moviesPath)) {
    const stat = await fs.stat(full);
    files.push({
      file: path.relative(moviesPath, full).split(path.sep).join('/'),
      size: stat.size,
      addedAt: stat.mtime.toISOString(),
    });
  }
  return files;
}

export async function readMoviesInfos(filePath) {
  try {
    const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return Array.isArray(data.movies) ? { ...data, shows: data.shows ?? {} } : { updatedAt: null, movies: [], shows: {} };
  } catch (err) {
    if (err.code === 'ENOENT') return { updatedAt: null, movies: [], shows: {} };
    throw err;
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await fs.rename(tmp, filePath);
}

// file → username of whoever downloaded it, written before the file shows up in MOVIES_PATH and kept
// until a scan copies it into the library entry (`addedBy`). Files copied in by hand have none.
const addedByPath = (config) => path.join(path.dirname(config.moviesInfosPath), 'added-by.json');

async function readAddedBy(config) {
  try {
    return JSON.parse(await fs.readFile(addedByPath(config), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

let addedByLock = Promise.resolve();

/** Runs `fn` on the file → username record, and saves it after. */
function updateAddedBy(config, fn) {
  const result = addedByLock.then(async () => {
    const record = await readAddedBy(config);
    fn(record);
    await writeJson(addedByPath(config), record);
  });
  addedByLock = result.catch(() => {});
  return result;
}

/** Remembers that `username` added `file` (relative to MOVIES_PATH), for the next scan. */
export function recordAddedBy(config, file, username) {
  return updateAddedBy(config, (record) => {
    record[file] = username;
  });
}

let libraryLock = Promise.resolve();

/**
 * Serialises changes to MOVIES_PATH / MOVIES_INFOS_PATH within the server (scans, converted files
 * replacing originals), so a scan never sees a file swap half done.
 */
export function runExclusive(fn) {
  const result = libraryLock.then(fn);
  libraryLock = result.catch(() => {});
  return result;
}

/** Point the entry of `oldFile` to `newFile`, keeping its id (watch progress) and TMDB data. */
export async function renameMovieEntry(config, oldFile, newFile) {
  const infos = await readMoviesInfos(config.moviesInfosPath);
  const movie = infos.movies.find((m) => m.file === oldFile);
  if (!movie) return false;
  movie.file = newFile;
  movie.size = (await fs.stat(path.join(config.moviesPath, newFile))).size;
  await writeJson(config.moviesInfosPath, infos);
  return true;
}

function toMovieInfo(base, details) {
  const director = details.credits?.crew?.find((c) => c.job === 'Director')?.name ?? null;
  return {
    ...base,
    matched: true,
    tmdbId: details.id,
    title: details.title,
    originalTitle: details.original_title,
    overview: details.overview || '',
    tagline: details.tagline || '',
    releaseDate: details.release_date || null,
    year: details.release_date ? Number(details.release_date.slice(0, 4)) : base.parsed.year,
    runtime: details.runtime || null,
    genres: (details.genres ?? []).map((g) => g.name),
    voteAverage: details.vote_average ?? null,
    posterPath: details.poster_path,
    backdropPath: details.backdrop_path,
    director,
    cast: (details.credits?.cast ?? []).slice(0, 6).map((c) => c.name),
    lookedUpAt: new Date().toISOString(),
  };
}

function unmatchedInfo(base) {
  return {
    ...base,
    matched: false,
    tmdbId: null,
    title: base.parsed.title,
    originalTitle: null,
    overview: '',
    tagline: '',
    releaseDate: null,
    year: base.parsed.year,
    runtime: null,
    genres: [],
    voteAverage: null,
    posterPath: null,
    backdropPath: null,
    director: null,
    cast: [],
    lookedUpAt: new Date().toISOString(),
  };
}

function toShowInfo(key, details) {
  return {
    key,
    matched: true,
    tmdbId: details.id,
    title: details.name,
    originalTitle: details.original_name,
    overview: details.overview || '',
    posterPath: details.poster_path,
    backdropPath: details.backdrop_path,
    genres: (details.genres ?? []).map((g) => g.name),
    voteAverage: details.vote_average ?? null,
    firstAirYear: details.first_air_date ? Number(details.first_air_date.slice(0, 4)) : null,
    seasons: {},
    lookedUpAt: new Date().toISOString(),
  };
}

function unmatchedShow(key, title) {
  return {
    key,
    matched: false,
    tmdbId: null,
    title,
    originalTitle: null,
    overview: '',
    posterPath: null,
    backdropPath: null,
    genres: [],
    voteAverage: null,
    firstAirYear: null,
    seasons: {},
    lookedUpAt: new Date().toISOString(),
  };
}

/** Episodes of a TMDB season, by episode number. */
function toSeasonInfo(details) {
  return Object.fromEntries(
    (details.episodes ?? []).map((e) => [
      e.episode_number,
      { name: e.name || '', overview: e.overview || '', stillPath: e.still_path ?? null, runtime: e.runtime || null, airDate: e.air_date || null },
    ]),
  );
}

/** Episodes keep every movie field, so code reading library items works for them too. */
function toEpisodeInfo(base, show) {
  const { season, episode, episodeEnd } = base.parsed;
  const seasonInfo = show.seasons[season];
  const details = seasonInfo?.[episode];
  return {
    ...base,
    kind: 'episode',
    showKey: show.key,
    season,
    episode,
    episodeEnd,
    // An episode missing from TMDB's season still counts as matched: it isn't looked up again.
    matched: Boolean(show.matched && seasonInfo),
    tmdbId: null,
    title: details?.name || `Épisode ${episode}`,
    originalTitle: null,
    overview: details?.overview || '',
    tagline: '',
    releaseDate: details?.airDate || null,
    year: details?.airDate ? Number(details.airDate.slice(0, 4)) : null,
    runtime: details?.runtime || null,
    stillPath: details?.stillPath || null,
    genres: [],
    voteAverage: null,
    posterPath: null,
    backdropPath: null,
    director: null,
    cast: [],
    lookedUpAt: new Date().toISOString(),
  };
}

/** Seasons of a TMDB show, fetched for the episodes we have. A season that fails is left out (looked up again next scan). */
async function fetchSeasons(client, show, seasons, logger) {
  for (const season of seasons) {
    try {
      show.seasons[season] = toSeasonInfo(await client.seasonDetails(show.tmdbId, season));
    } catch (err) {
      logger.error?.({ show: show.title, season, error: err.message }, 'TMDB season lookup failed');
    }
  }
}

/**
 * Looks a movie up again on TMDB under `name`, typed by a user when the filename gave no match or the
 * wrong one. The name is kept, so later scans search it too. Returns `{ item }`, `{ missing: true }`
 * when no movie has this id, or `{ noMatch: true }` when TMDB finds nothing.
 */
export async function rematchMovie(config, id, name, { tmdb, logger = log } = {}) {
  if (!(await readMoviesInfos(config.moviesInfosPath)).movies.some((m) => m.id === id && m.kind !== 'episode')) return { missing: true };
  const client = tmdb ?? createTmdbClient(config.tmdbApiKey);
  const hit = await client.searchMovie(name);
  if (!hit) return { noMatch: true };
  const details = await client.movieDetails(hit.id);
  return runExclusive(async () => {
    // Read again: a scan or a conversion may have rewritten the file meanwhile.
    const infos = await readMoviesInfos(config.moviesInfosPath);
    const index = infos.movies.findIndex((m) => m.id === id && m.kind !== 'episode');
    if (index === -1) return { missing: true };
    const movie = infos.movies[index];
    const item = { ...toMovieInfo({ ...movie, parsed: movie.parsed ?? parseMovieFilename(movie.file) }, details), searchName: name };
    infos.movies[index] = item;
    await writeJson(config.moviesInfosPath, infos);
    logger.info?.({ file: movie.file, searchedName: name, match: item.title }, 'Movie matched on TMDB by name');
    return { item };
  });
}

/** Same as rematchMovie for a whole show: the show and all its episodes get the new TMDB data. */
export async function rematchShow(config, key, name, { tmdb, logger = log } = {}) {
  const before = await readMoviesInfos(config.moviesInfosPath);
  if (!before.shows[key]) return { missing: true };
  const client = tmdb ?? createTmdbClient(config.tmdbApiKey);
  const hit = await client.searchTv(name);
  if (!hit) return { noMatch: true };
  const show = { ...toShowInfo(key, await client.tvDetails(hit.id)), searchName: name };
  const seasons = [...new Set(before.movies.filter((m) => m.showKey === key).map((m) => m.season))].sort((a, b) => a - b);
  await fetchSeasons(client, show, seasons, logger);
  return runExclusive(async () => {
    const infos = await readMoviesInfos(config.moviesInfosPath);
    if (!infos.shows[key]) return { missing: true };
    infos.shows[key] = show;
    infos.movies = infos.movies.map((m) => (m.kind === 'episode' && m.showKey === key ? toEpisodeInfo(m, show) : m));
    await writeJson(config.moviesInfosPath, infos);
    logger.info?.({ show: key, searchedName: name, match: show.title }, 'Show matched on TMDB by name');
    return { item: show };
  });
}

/**
 * Deletes the files of the given library entries from MOVIES_PATH (and folders left empty), then
 * their entries, and shows left without episodes. Returns the deleted entries.
 */
export async function deleteLibraryItems(config, ids) {
  const wanted = new Set(ids);
  return runExclusive(async () => {
    const infos = await readMoviesInfos(config.moviesInfosPath);
    const deleted = infos.movies.filter((m) => wanted.has(m.id));
    for (const movie of deleted) {
      const filePath = path.resolve(config.moviesPath, movie.file);
      if (!filePath.startsWith(config.moviesPath + path.sep)) continue;
      await fs.rm(filePath, { force: true });
      for (let folder = path.dirname(filePath); folder.startsWith(config.moviesPath + path.sep); folder = path.dirname(folder)) {
        try {
          await fs.rmdir(folder);
        } catch {
          break; // not empty
        }
      }
    }
    if (!deleted.length) return deleted;
    infos.movies = infos.movies.filter((m) => !wanted.has(m.id));
    const showKeys = new Set(infos.movies.map((m) => m.showKey).filter(Boolean));
    infos.shows = Object.fromEntries(Object.entries(infos.shows).filter(([key]) => showKeys.has(key)));
    await writeJson(config.moviesInfosPath, infos);
    return deleted;
  });
}

async function runPool(items, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(runners);
}

/**
 * Sync MOVIES_INFOS_PATH with the content of MOVIES_PATH.
 * Only new files (and previously unmatched ones) hit TMDB unless `force` is set.
 * Episodes ("Show.S01E02…") are grouped by show: one TMDB lookup per show and per season.
 */
export async function scanMovies(config, { force = false, logger = log, tmdb } = {}) {
  const previous = await readMoviesInfos(config.moviesInfosPath);
  const addedBy = await readAddedBy(config);
  const known = new Map(previous.movies.map((m) => [m.file, m]));
  const files = await listVideoFiles(config.moviesPath);

  const result = [];
  const moviesToLookUp = [];
  const episodesByShow = new Map();
  // Existing entries keep their id (watch progress is keyed by it), even when a conversion renamed the
  // file; new files get one derived from their path, made unique if a converted movie already holds it.
  const usedIds = new Set(files.map((f) => known.get(f.file)?.id).filter(Boolean));
  const newId = (file) => {
    let id = movieId(file);
    for (let n = 1; usedIds.has(id); n++) id = movieId(`${file}#${n}`);
    usedIds.add(id);
    return id;
  };
  for (const f of files) {
    const existing = known.get(f.file);
    const by = existing?.addedBy ?? addedBy[f.file];
    if (by) f.addedBy = by;
    const episode = parseEpisodeFilename(f.file);
    // Older versions matched episodes as movies: those are looked up again, as episodes.
    const sameKind = (existing?.kind === 'episode') === Boolean(episode);
    if (existing && existing.matched && sameKind && !force) {
      result.push({ ...existing, ...f });
      continue;
    }
    const id = existing?.id ?? newId(f.file);
    if (!episode) {
      moviesToLookUp.push({ id, ...f, parsed: parseMovieFilename(f.file), ...(existing?.searchName && { searchName: existing.searchName }) });
      continue;
    }
    const key = showKey(episode.showTitle);
    if (!episodesByShow.has(key)) episodesByShow.set(key, []);
    episodesByShow.get(key).push({ id, ...f, parsed: episode });
  }

  const stats = { total: files.length, lookedUp: 0, matched: 0, unmatched: 0, errors: 0 };
  const shows = {};
  let client;

  async function lookUpMovie(base) {
    try {
      // A name typed by a user (rematchMovie) wins over the one guessed from the filename.
      const hit = base.searchName ? await client.searchMovie(base.searchName) : await client.searchMovie(base.parsed.title, base.parsed.year);
      if (hit) {
        result.push(toMovieInfo(base, await client.movieDetails(hit.id)));
        stats.matched++;
      } else {
        result.push(unmatchedInfo(base));
        stats.unmatched++;
        logger.warn?.({ file: base.file, searched: base.parsed.title, year: base.parsed.year ?? null }, 'No TMDB match for a movie');
      }
    } catch (err) {
      // Keep the previous entry (or a placeholder) so the movie stays visible; it is retried next scan.
      result.push(known.get(base.file) ?? unmatchedInfo(base));
      stats.errors++;
      logger.error?.({ file: base.file, error: err.message }, 'TMDB movie lookup failed');
    }
  }

  async function lookUpShow(key, episodes) {
    const { showTitle } = episodes[0].parsed;
    const previousShow = previous.shows[key];
    let show = previousShow?.matched && !force ? { ...previousShow, seasons: { ...previousShow.seasons } } : null;
    try {
      if (!show) {
        const year = episodes.find((e) => e.parsed.year)?.parsed.year ?? null;
        const searchName = previousShow?.searchName;
        const hit = searchName ? await client.searchTv(searchName) : await client.searchTv(showTitle, year);
        show = hit ? toShowInfo(key, await client.tvDetails(hit.id)) : unmatchedShow(key, showTitle);
        if (searchName) show.searchName = searchName;
        if (!hit) logger.warn?.({ searched: searchName ?? showTitle, year: (!searchName && year) || null }, 'No TMDB match for a show');
      }
    } catch (err) {
      // Keep the previous entries (or placeholders) so the episodes stay visible; retried next scan.
      shows[key] = previousShow ?? unmatchedShow(key, showTitle);
      for (const base of episodes) {
        const old = known.get(base.file);
        result.push(old?.kind === 'episode' ? old : toEpisodeInfo(base, shows[key]));
      }
      stats.errors += episodes.length;
      logger.error?.({ show: showTitle, error: err.message }, 'TMDB show lookup failed');
      return;
    }
    if (show.matched) {
      const seasons = [...new Set(episodes.map((e) => e.parsed.season))].sort((a, b) => a - b);
      for (const season of seasons) {
        // Fetched again when a new episode isn't in it yet (a show still airing).
        const cached = show.seasons[season];
        if (cached && episodes.every((e) => e.parsed.season !== season || cached[e.parsed.episode])) continue;
        try {
          show.seasons[season] = toSeasonInfo(await client.seasonDetails(show.tmdbId, season));
        } catch (err) {
          // Its episodes stay unmatched ("Épisode N") and the season is fetched again next scan.
          stats.errors++;
          logger.error?.({ show: show.title, season, error: err.message }, 'TMDB season lookup failed');
        }
      }
    }
    shows[key] = show;
    for (const base of episodes) {
      const info = toEpisodeInfo(base, show);
      result.push(info);
      if (info.matched) stats.matched++;
      else stats.unmatched++;
    }
  }

  const tasks = [
    ...moviesToLookUp.map((base) => () => lookUpMovie(base)),
    ...[...episodesByShow].map(([key, episodes]) => () => lookUpShow(key, episodes)),
  ];
  stats.lookedUp = moviesToLookUp.length + [...episodesByShow.values()].reduce((n, list) => n + list.length, 0);
  if (tasks.length) {
    client = tmdb ?? createTmdbClient(config.tmdbApiKey);
    await runPool(tasks, (task) => task());
  }

  // Shows of episodes that weren't looked up, then only seasons that still have a file.
  for (const item of result) {
    if (item.kind === 'episode') shows[item.showKey] ??= previous.shows[item.showKey] ?? unmatchedShow(item.showKey, item.showKey);
  }
  for (const show of Object.values(shows)) {
    const seasons = new Set(result.filter((m) => m.showKey === show.key).map((m) => String(m.season)));
    show.seasons = Object.fromEntries(Object.entries(show.seasons).filter(([n]) => seasons.has(n)));
  }
  stats.shows = Object.keys(shows).length;

  result.sort((a, b) => a.file.localeCompare(b.file));
  const present = new Set(files.map((f) => f.file));
  stats.removed = previous.movies.filter((m) => !present.has(m.file)).length;
  await writeJson(config.moviesInfosPath, { updatedAt: new Date().toISOString(), movies: result, shows });
  // Now in the library entries. Read again: a download may have finished during the scan.
  if (files.some((f) => addedBy[f.file])) {
    await updateAddedBy(config, (record) => {
      for (const f of files) if (record[f.file] === addedBy[f.file]) delete record[f.file];
    });
  }
  return stats;
}
