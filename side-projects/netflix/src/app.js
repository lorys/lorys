import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { authenticate, createAccountsStore } from './accounts.js';
import { createSessionToken, readSessionToken, SESSION_COOKIE, SESSION_TTL_MS } from './session.js';
import { readMoviesInfos } from './scanner.js';
import { createDownloadManager } from './downloads.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ogv': 'video/ogg',
};

// Re-read MOVIES_INFOS_PATH only when the scanner has rewritten it.
function createInfosCache(filePath) {
  let cached = null;
  let cachedMtime = 0;
  return async () => {
    let mtime = 0;
    try {
      mtime = (await fsp.stat(filePath)).mtimeMs;
    } catch {}
    if (!cached || mtime !== cachedMtime) {
      cached = await readMoviesInfos(filePath);
      cachedMtime = mtime;
    }
    return cached;
  };
}

/** The movie counts as watched once only the end credits are left. */
export function isFinished(position, duration) {
  return duration - position <= Math.max(60, duration * 0.05);
}

export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match) return null;
  let start;
  let end;
  if (match[1] === '') {
    // Suffix range: last N bytes.
    const suffix = Number(match[2]);
    if (!suffix) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

export function buildApp(config, { logger = true } = {}) {
  const app = Fastify({ logger });
  const getInfos = createInfosCache(config.moviesInfosPath);
  const accounts = createAccountsStore(config.accountsPath, config.accountsSecret);
  const downloads = createDownloadManager(config.moviesPath, { logger: app.log });
  app.addHook('onClose', () => downloads.close());

  app.register(fastifyCookie);
  app.register(fastifyStatic, { root: PUBLIC_DIR });

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = readSessionToken(request.cookies[SESSION_COOKIE], config.sessionSecret);
  });

  const requireUser = async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Non authentifié' });
  };

  app.post('/api/login', {
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: { username: { type: 'string', maxLength: 200 }, password: { type: 'string', maxLength: 500 } },
      },
    },
    handler: async (request, reply) => {
      const username = await authenticate(accounts, request.body.username, request.body.password);
      if (!username) return reply.code(401).send({ error: 'Identifiant ou mot de passe incorrect' });
      reply.setCookie(SESSION_COOKIE, createSessionToken(username, config.sessionSecret), {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: request.protocol === 'https',
        maxAge: SESSION_TTL_MS / 1000,
      });
      return { username };
    },
  });

  app.post('/api/logout', async (request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', { preHandler: requireUser }, async (request) => ({ username: request.user }));

  app.get('/api/movies', { preHandler: requireUser }, async () => {
    const { updatedAt, movies } = await getInfos();
    // `parsed` and `size` are scanner internals; the frontend doesn't need them.
    return { updatedAt, movies: movies.map(({ parsed, size, ...movie }) => movie) };
  });

  // ---------- Watch progress (stored per account in ACCOUNTS_PATH) ----------

  app.get('/api/progress', { preHandler: requireUser }, async (request, reply) => {
    const account = (await accounts.read()).find((a) => a.username === request.user);
    if (!account) return reply.code(401).send({ error: 'Compte introuvable' });
    const { movies } = await getInfos();
    const ids = new Set(movies.map((m) => m.id));
    // Hide progress of movies that are no longer in the library (kept in case they come back).
    return Object.fromEntries(Object.entries(account.progress ?? {}).filter(([id]) => ids.has(id)));
  });

  const progressParams = {
    type: 'object',
    properties: { id: { type: 'string', pattern: '^[0-9a-f]{12}$' } },
  };

  app.put('/api/progress/:id', {
    preHandler: requireUser,
    schema: {
      params: progressParams,
      body: {
        type: 'object',
        required: ['position', 'duration'],
        properties: { position: { type: 'number', minimum: 0 }, duration: { type: 'number', exclusiveMinimum: 0 } },
      },
    },
    handler: async (request, reply) => {
      const { movies } = await getInfos();
      if (!movies.some((m) => m.id === request.params.id)) return reply.code(404).send({ error: 'Film introuvable' });
      const { position, duration } = request.body;
      const entry = isFinished(position, duration)
        ? null
        : { position: Math.min(Math.round(position), Math.floor(duration)), duration: Math.round(duration), updatedAt: new Date().toISOString() };
      const found = await accounts.update((list) => {
        const account = list.find((a) => a.username === request.user);
        if (!account) return false;
        account.progress ??= {};
        // A finished movie leaves "continue watching".
        if (entry) account.progress[request.params.id] = entry;
        else delete account.progress[request.params.id];
        return true;
      });
      if (!found) return reply.code(401).send({ error: 'Compte introuvable' });
      return { progress: entry };
    },
  });

  app.delete('/api/progress/:id', { preHandler: requireUser, schema: { params: progressParams } }, async (request, reply) => {
    const found = await accounts.update((list) => {
      const account = list.find((a) => a.username === request.user);
      if (account?.progress) delete account.progress[request.params.id];
      return Boolean(account);
    });
    if (!found) return reply.code(401).send({ error: 'Compte introuvable' });
    return { progress: null };
  });

  // ---------- Downloads into MOVIES_PATH ----------

  app.get('/api/downloads', { preHandler: requireUser }, async () => downloads.list());

  app.post('/api/downloads', {
    preHandler: requireUser,
    schema: {
      body: {
        type: 'object',
        required: ['url'],
        properties: { url: { type: 'string', maxLength: 4000 } },
      },
    },
    handler: async (request, reply) => {
      let url;
      try {
        url = new URL(request.body.url.trim());
      } catch {}
      if (!url || !['http:', 'https:'].includes(url.protocol)) {
        return reply.code(400).send({ error: 'Lien invalide (http ou https attendu)' });
      }
      return reply.code(201).send(downloads.start(url.href));
    },
  });

  app.delete('/api/downloads/:id', { preHandler: requireUser }, async (request, reply) => {
    if (!downloads.remove(request.params.id)) return reply.code(404).send({ error: 'Téléchargement introuvable' });
    return { ok: true };
  });

  app.get('/api/movies/:id/stream', { preHandler: requireUser }, async (request, reply) => {
    const { movies } = await getInfos();
    const movie = movies.find((m) => m.id === request.params.id);
    if (!movie) return reply.code(404).send({ error: 'Film introuvable' });

    // Only paths listed in the infos file are served, and they must stay inside MOVIES_PATH.
    const filePath = path.resolve(config.moviesPath, movie.file);
    if (!filePath.startsWith(config.moviesPath + path.sep)) return reply.code(404).send({ error: 'Film introuvable' });

    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return reply.code(404).send({ error: 'Fichier introuvable' });
    }

    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    reply.header('Accept-Ranges', 'bytes').type(type);

    if (!request.headers.range) {
      reply.header('Content-Length', stat.size);
      return reply.send(fs.createReadStream(filePath));
    }
    const range = parseRange(request.headers.range, stat.size);
    if (!range) {
      return reply.code(416).header('Content-Range', `bytes */${stat.size}`).send();
    }
    reply
      .code(206)
      .header('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`)
      .header('Content-Length', range.end - range.start + 1);
    return reply.send(fs.createReadStream(filePath, range));
  });

  return app;
}
