import path from 'node:path';

export function loadConfig(env = process.env) {
  const required = (name) => {
    if (!env[name]) throw new Error(`Missing required environment variable ${name}`);
    return env[name];
  };
  return {
    moviesPath: path.resolve(required('MOVIES_PATH')),
    moviesInfosPath: path.resolve(required('MOVIES_INFOS_PATH')),
    accountsPath: path.resolve(required('ACCOUNTS_PATH')),
    accountsSecret: required('ACCOUNTS_SECRET'),
    tmdbApiKey: env.THEMOVIEDB_API_KEY || '',
    sessionSecret: env.SESSION_SECRET || required('ACCOUNTS_SECRET'),
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT || 3000),
    scanOnStart: env.SCAN_ON_START !== 'false',
  };
}
