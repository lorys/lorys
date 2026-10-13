import { loadConfig } from './config.js';
import { connectDb } from './db.js';
import { buildApp } from './app.js';

const config = loadConfig();
const { client, db } = await connectDb(config.mongodbUri);
const app = buildApp(config, db);

await app.listen({ host: config.host, port: config.port });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    await client.close();
    process.exit(0);
  });
}
