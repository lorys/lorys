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

const watcher = watchMovies(config, { logger: app.log, onScanned: enqueueAll });
const scanned = config.scanOnStart ? watcher.check() : Promise.resolve();
if (config.convertOnStart) {
  scanned
    .then(async () => enqueueAll((await readMoviesInfos(config.moviesInfosPath)).movies))
    .catch((err) => app.log.error(err, 'Cannot queue conversions'));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    watcher.close();
    await app.close(); // also stops a running conversion
    process.exit(0);
  });
}
