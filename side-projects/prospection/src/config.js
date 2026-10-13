export function loadConfig(env = process.env) {
  const missing = ['PASSWORD', 'MONGODB_URI'].filter((key) => !env[key]);
  if (missing.length) throw new Error(`Variable(s) d'environnement manquante(s) : ${missing.join(', ')}`);
  return {
    password: env.PASSWORD,
    mongodbUri: env.MONGODB_URI,
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT) || 3000,
  };
}
