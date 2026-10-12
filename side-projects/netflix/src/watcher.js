// Keeps MOVIES_INFOS_PATH in sync with MOVIES_PATH: whenever the set of video files
// differs from what the infos file describes (movie added, removed or renamed),
// an incremental TMDB scan runs automatically.
// After a scan, `onScanned` receives the movies it added (they may need a conversion);
// `onChecked` runs after every check, scan or not (files may have changed in place).
import fs from 'node:fs';
import { parseEpisodeFilename } from './filename.js';
import { listVideoFiles, readMoviesInfos, runExclusive, scanMovies } from './scanner.js';

const DEBOUNCE_MS = 5_000;
const DEFAULT_POLL_MS = 60_000;

export async function needsScan(config) {
  const [files, infos] = await Promise.all([listVideoFiles(config.moviesPath), readMoviesInfos(config.moviesInfosPath)]);
  if (files.length !== infos.movies.length) return true;
  const known = new Set(infos.movies.map((m) => m.file));
  if (files.some((f) => !known.has(f.file))) return true;
  // Infos written before series support hold episodes as movies: rescan them as episodes.
  return infos.movies.some((m) => (m.kind === 'episode') !== Boolean(parseEpisodeFilename(m.file)));
}

export function watchMovies(config, { logger = console, pollMs = DEFAULT_POLL_MS, scan = scanMovies, onScanned, onChecked } = {}) {
  let running = null;
  let rerun = false;
  let debounce = null;

  async function check() {
    if (running) {
      rerun = true; // something changed mid-scan: check again once it's done
      return running;
    }
    running = (async () => {
      do {
        rerun = false;
        try {
          // Under the library lock: a conversion never swaps a file while we list or scan.
          const added = await runExclusive(async () => {
            if (!(await needsScan(config))) return [];
            const before = new Set((await readMoviesInfos(config.moviesInfosPath)).movies.map((m) => m.file));
            logger.info('Movie library changed, scanning TMDB…');
            const stats = await scan(config, { logger });
            logger.info(stats, 'Movie scan finished');
            return (await readMoviesInfos(config.moviesInfosPath)).movies.filter((m) => !before.has(m.file));
          });
          if (added.length) onScanned?.(added);
        } catch (err) {
          logger.error(err, 'Movie scan failed');
        }
      } while (rerun);
      onChecked?.();
    })();
    try {
      await running;
    } finally {
      running = null;
    }
  }

  function schedule() {
    clearTimeout(debounce);
    // Wait for copies to settle before listing files.
    debounce = setTimeout(check, DEBOUNCE_MS);
  }

  let watcher = null;
  try {
    watcher = fs.watch(config.moviesPath, { recursive: true }, schedule);
    watcher.on('error', (err) => logger.warn(`File watcher error, relying on polling: ${err.message}`));
  } catch (err) {
    logger.warn(`Cannot watch ${config.moviesPath} (${err.message}), relying on polling`);
  }
  // Polling also covers network mounts where fs events aren't delivered.
  const poll = setInterval(check, pollMs);
  poll.unref();

  return {
    check,
    close() {
      clearTimeout(debounce);
      clearInterval(poll);
      watcher?.close();
    },
  };
}
