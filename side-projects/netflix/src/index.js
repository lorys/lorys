import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { watchMovies } from './watcher.js';

const config = loadConfig();
const app = buildApp(config);

await app.listen({ host: config.host, port: config.port });

const watcher = watchMovies(config, { logger: app.log });
if (config.scanOnStart) watcher.check();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    watcher.close();
    await app.close();
    process.exit(0);
  });
}
