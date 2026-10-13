import { MongoClient } from 'mongodb';

export async function connectDb(uri) {
  const client = new MongoClient(uri);
  await client.connect();
  // Base indiquée dans l'URI, sinon "prospection" (le pilote retombe sur "test" par défaut).
  const db = client.db(client.options.dbName === 'test' && !/\/test(\?|$)/.test(uri) ? 'prospection' : undefined);
  await db.collection('targets').createIndex({ commercialId: 1, nextDate: 1 });
  return { client, db };
}
