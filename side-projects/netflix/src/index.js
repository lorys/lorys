import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { readMoviesInfos } from './scanner.js';
import { watchMovies } from './watcher.js';

const config = loadConfig();
const app = buildApp(config);
const { conversions } = app;

await app.listen({ host: config.host, port: config.port });
await conversions.cleanup();

// One at a time: each enqueue runs ffprobe on the file.
async function enqueueAll(movies) {
  for (const movie of movies) await conversions.enqueue(movie);
}

// The whole library: at startup, then after each check of the watcher (retries failed movies whose
// file changed, picks up files replaced in place). Skipped when CONVERT_ON_START=false.
let queuing = null;
function enqueueLibrary() {
  queuing ??= readMoviesInfos(config.moviesInfosPath)
    .then(({ movies }) => enqueueAll(movies))
    .catch((err) => app.log.error(err, 'Cannot queue conversions'))
    .finally(() => {
      queuing = null;
    });
  return queuing;
}

const watcher = watchMovies(config, {
  logger: app.log,
  onScanned: enqueueAll,
  onChecked: config.convertOnStart ? enqueueLibrary : undefined,
});
const scanned = config.scanOnStart ? watcher.check() : Promise.resolve();
if (config.convertOnStart) scanned.then(enqueueLibrary);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    watcher.close();
    await app.close(); // also stops a running conversion
    process.exit(0);
  });
}
