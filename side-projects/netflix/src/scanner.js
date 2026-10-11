import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseMovieFilename, VIDEO_EXTENSIONS } from './filename.js';
import { createTmdbClient } from './tmdb.js';

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
    return Array.isArray(data.movies) ? data : { updatedAt: null, movies: [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { updatedAt: null, movies: [] };
    throw err;
  }
}

async function writeMoviesInfos(filePath, infos) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(infos, null, 2) + '\n');
  await fs.rename(tmp, filePath);
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
  await writeMoviesInfos(config.moviesInfosPath, infos);
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
 */
export async function scanMovies(config, { force = false, logger = console, tmdb } = {}) {
  const previous = await readMoviesInfos(config.moviesInfosPath);
  const known = new Map(previous.movies.map((m) => [m.file, m]));
  const files = await listVideoFiles(config.moviesPath);

  const result = [];
  const toLookUp = [];
  for (const f of files) {
    const existing = known.get(f.file);
    if (existing && existing.matched && !force) {
      result.push({ ...existing, size: f.size, addedAt: f.addedAt });
    } else {
      toLookUp.push({ id: movieId(f.file), ...f, parsed: parseMovieFilename(f.file) });
    }
  }

  const stats = { total: files.length, lookedUp: toLookUp.length, matched: 0, unmatched: 0, errors: 0 };
  if (toLookUp.length) {
    const client = tmdb ?? createTmdbClient(config.tmdbApiKey);
    await runPool(toLookUp, async (base) => {
      try {
        const hit = await client.searchMovie(base.parsed.title, base.parsed.year);
        if (hit) {
          result.push(toMovieInfo(base, await client.movieDetails(hit.id)));
          stats.matched++;
        } else {
          result.push(unmatchedInfo(base));
          stats.unmatched++;
          logger.warn?.(`No TMDB match for "${base.file}" (searched "${base.parsed.title}"${base.parsed.year ? ` ${base.parsed.year}` : ''})`);
        }
      } catch (err) {
        // Keep the previous entry (or a placeholder) so the movie stays visible; it is retried next scan.
        result.push(known.get(base.file) ?? unmatchedInfo(base));
        stats.errors++;
        logger.error?.(`TMDB lookup failed for "${base.file}": ${err.message}`);
      }
    });
  }

  result.sort((a, b) => a.file.localeCompare(b.file));
  const present = new Set(files.map((f) => f.file));
  stats.removed = previous.movies.filter((m) => !present.has(m.file)).length;
  await writeMoviesInfos(config.moviesInfosPath, { updatedAt: new Date().toISOString(), movies: result });
  return stats;
}
