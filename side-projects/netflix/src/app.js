import crypto from 'node:crypto';
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
import { createConversionManager } from './conversions.js';
import { createDownloadManager, diskUsage, DownloadRefusedError } from './downloads.js';
import { createSubtitlesService } from './subtitles.js';
import { addAMovie } from './addAMovie.js';

// Movies found by addAMovie() wait this long for the user to pick one and confirm the download.
const PENDING_MOVIE_TTL_MS = 15 * 60_000;

// A user counts as watching while their player saved progress this recently (it saves every 10 s).
const WATCHING_TTL_MS = 30_000;

// At most one login attempt every this long, all clients together (brute force and scrypt load).
const LOGIN_INTERVAL_MS = 2_000;

// Everything is served from this origin, except posters and backdrops (TMDB, or wherever add-movie found them).
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' https: data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

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

export function buildApp(config, { logger = true, conversions, loginIntervalMs = LOGIN_INTERVAL_MS } = {}) {
  const app = Fastify({ logger });
  const getInfos = createInfosCache(config.moviesInfosPath);
  const accounts = createAccountsStore(config.accountsPath, config.accountsSecret);
  const downloads = createDownloadManager(config.moviesPath, { logger: app.log });
  conversions ??= createConversionManager(config, { logger: app.log });
  app.decorate('conversions', conversions);
  const subtitles = createSubtitlesService(config.moviesPath, path.join(path.dirname(config.moviesInfosPath), 'subtitles'));
  app.addHook('onClose', () => downloads.close());
  app.addHook('onClose', () => conversions.close());

  app.addHook('onSend', async (request, reply) => {
    reply.headers(SECURITY_HEADERS);
  });

  app.register(fastifyCookie);
  app.register(fastifyStatic, { root: PUBLIC_DIR });

  // `session` is what the cookie claims; `user` is only set once requireUser checked it against the account.
  app.decorateRequest('session', null);
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.session = readSessionToken(request.cookies[SESSION_COOKIE], config.sessionSecret);
  });

  // The account must still exist and not have revoked its sessions (logout, password change).
  const requireUser = async (request, reply) => {
    const { session } = request;
    const account = session && (await accounts.read()).find((a) => a.username === session.username);
    if (!account || (account.sessionVersion ?? 0) !== session.version) return reply.code(401).send({ error: 'Non authentifié' });
    request.user = account.username;
  };

  let lastLoginAt = -Infinity;

  app.post('/api/login', {
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: { username: { type: 'string', maxLength: 200 }, password: { type: 'string', maxLength: 500 } },
      },
    },
    handler: async (request, reply) => {
      // Refused before any scrypt work, so a flood of attempts costs nothing.
      const now = Date.now();
      if (now - lastLoginAt < loginIntervalMs) {
        return reply
          .code(429)
          .header('Retry-After', Math.ceil(loginIntervalMs / 1000))
          .send({ error: 'Trop de tentatives de connexion, réessayez dans quelques secondes' });
      }
      lastLoginAt = now;
      const user = await authenticate(accounts, request.body.username, request.body.password);
      if (!user) return reply.code(401).send({ error: 'Identifiant ou mot de passe incorrect' });
      reply.setCookie(SESSION_COOKIE, createSessionToken(user.username, user.sessionVersion, config.sessionSecret), {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        maxAge: SESSION_TTL_MS / 1000,
      });
      return { username: user.username };
    },
  });

  // Revokes every session of the user (all devices), not just this cookie.
  app.post('/api/logout', async (request, reply) => {
    const { session } = request;
    if (session) {
      await accounts.update((list) => {
        const account = list.find((a) => a.username === session.username);
        if (account && (account.sessionVersion ?? 0) === session.version) account.sessionVersion = session.version + 1;
      });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', { preHandler: requireUser }, async (request) => ({ username: request.user }));

  app.get('/api/movies', { preHandler: requireUser }, async () => {
    const { updatedAt, movies, shows } = await getInfos();
    // `parsed` and `size` are scanner internals; the frontend doesn't need them.
    return {
      updatedAt,
      shows,
      movies: movies.map(({ parsed, size, ...movie }) => {
        const conversion = conversions.status(movie.id);
        return conversion ? { ...movie, conversion } : movie;
      }),
    };
  });

  app.get('/api/conversions', { preHandler: requireUser }, async () => conversions.list());

  // Disk usage of the filesystem holding the data folder (/data in Docker).
  app.get('/api/disk', { preHandler: requireUser }, async () => diskUsage(path.dirname(config.moviesInfosPath)));

  // ---------- Watch progress (stored per account in ACCOUNTS_PATH) ----------

  // username → { movieId, position, duration, updatedAt }: last progress saved, kept in memory only.
  const lastProgress = new Map();

  app.get('/api/watching', { preHandler: requireUser }, async () => {
    const ids = new Set((await getInfos()).movies.map((m) => m.id));
    const now = Date.now();
    return [...lastProgress]
      .filter(([, entry]) => now - entry.updatedAt < WATCHING_TTL_MS && ids.has(entry.movieId))
      .map(([username, entry]) => ({ username, ...entry }));
  });

  // Hide entries of movies that are no longer in the library (kept in case they come back).
  const onlyInLibrary = async (record = {}) => {
    const ids = new Set((await getInfos()).movies.map((m) => m.id));
    return Object.fromEntries(Object.entries(record).filter(([id]) => ids.has(id)));
  };

  app.get('/api/progress', { preHandler: requireUser }, async (request, reply) => {
    const account = (await accounts.read()).find((a) => a.username === request.user);
    if (!account) return reply.code(401).send({ error: 'Compte introuvable' });
    return onlyInLibrary(account.progress);
  });

  // Movies and episodes watched to the end: tells which episode of a show comes next.
  app.get('/api/watched', { preHandler: requireUser }, async (request, reply) => {
    const account = (await accounts.read()).find((a) => a.username === request.user);
    if (!account) return reply.code(401).send({ error: 'Compte introuvable' });
    return onlyInLibrary(account.watched);
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
      const finished = isFinished(position, duration);
      const entry = finished
        ? null
        : { position: Math.min(Math.round(position), Math.floor(duration)), duration: Math.round(duration), updatedAt: new Date().toISOString() };
      const watchedAt = finished ? new Date().toISOString() : null;
      const found = await accounts.update((list) => {
        const account = list.find((a) => a.username === request.user);
        if (!account) return false;
        account.progress ??= {};
        // A finished movie leaves "continue watching" and is remembered as watched.
        if (entry) {
          account.progress[request.params.id] = entry;
        } else {
          delete account.progress[request.params.id];
          account.watched ??= {};
          account.watched[request.params.id] = watchedAt;
        }
        return true;
      });
      if (!found) return reply.code(401).send({ error: 'Compte introuvable' });
      if (entry) lastProgress.set(request.user, { movieId: request.params.id, position, duration, updatedAt: Date.now() });
      else lastProgress.delete(request.user);
      return { progress: entry, watched: watchedAt };
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

  // 201 with the new download, or the reason it was refused (too many running, disk almost full).
  const startDownload = async (reply, href, options) => {
    try {
      return reply.code(201).send(await downloads.start(href, options));
    } catch (err) {
      if (!(err instanceof DownloadRefusedError)) throw err;
      return reply.code(err.statusCode).send({ error: err.message });
    }
  };

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
      return startDownload(reply, url.href);
    },
  });

  app.delete('/api/downloads/:id', { preHandler: requireUser }, async (request, reply) => {
    if (!downloads.remove(request.params.id)) return reply.code(404).send({ error: 'Téléchargement introuvable' });
    return { ok: true };
  });

  // ---------- Adding a movie by its exact name (when a search finds nothing) ----------

  // The `download` callback of each found movie stays here until the user picks one and confirms.
  // Movies found by the same search share a `search` id, so confirming one discards the others.
  const pendingMovies = new Map(); // token → { username, search, download, expiresAt }

  const prunePendingMovies = () => {
    for (const [token, pending] of pendingMovies) {
      if (pending.expiresAt < Date.now()) pendingMovies.delete(token);
    }
  };

  app.post('/api/add-movie', {
    preHandler: requireUser,
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1, maxLength: 300 } },
      },
    },
    handler: async (request, reply) => {
      const name = request.body.name.trim();
      if (!name) return reply.code(400).send({ error: 'Indiquez le nom du film' });
      let found;
      try {
        found = await addAMovie(name);
      } catch (err) {
        request.log.error(err, 'addAMovie failed');
        return reply.code(502).send({ error: 'La recherche du film a échoué' });
      }
      if (found && !Array.isArray(found) && found.ok === false && found.error !== 'not found') {
        return reply.code(404).send({ error: String(found.error) });
      }
      const movies = Array.isArray(found) ? found.filter(Boolean) : [];
      const invalid = movies.filter((movie) => typeof movie.download !== 'function');
      if (invalid.length) request.log.error({ invalid: invalid.length }, 'addAMovie returned movies without a download callback');
      const choices = movies.filter((movie) => typeof movie.download === 'function');
      if (!choices.length) {
        if (invalid.length) return reply.code(502).send({ error: 'La recherche du film a échoué' });
        return reply.code(404).send({ error: `Aucun film trouvé pour « ${name} »` });
      }
      prunePendingMovies();
      const search = crypto.randomBytes(12).toString('hex');
      const expiresAt = Date.now() + PENDING_MOVIE_TTL_MS;
      return {
        movies: choices.map((movie) => {
          const token = crypto.randomBytes(12).toString('hex');
          pendingMovies.set(token, { username: request.user, search, download: movie.download, expiresAt });
          return { token, movieName: movie.movieName ?? name, imgUrl: movie.imgUrl ?? null, size: movie.size ?? null };
        }),
      };
    },
  });

  app.post('/api/add-movie/:token/download', { preHandler: requireUser }, async (request, reply) => {
    prunePendingMovies();
    const pending = pendingMovies.get(request.params.token);
    if (!pending || pending.username !== request.user) {
      return reply.code(404).send({ error: 'Cette recherche a expiré, recommencez' });
    }
    for (const [token, other] of pendingMovies) {
      if (other.search === pending.search) pendingMovies.delete(token);
    }
    let link;
    let filename;
    try {
      ({ link, filename } = await pending.download());
    } catch (err) {
      request.log.error(err, 'addAMovie download callback failed');
      return reply.code(502).send({ error: "Impossible d'obtenir le lien de téléchargement" });
    }
    let url;
    try {
      url = new URL(String(link));
    } catch {}
    if (!url || !['http:', 'https:'].includes(url.protocol)) {
      request.log.error({ link }, 'addAMovie returned an invalid link');
      return reply.code(502).send({ error: 'Le lien de téléchargement obtenu est invalide' });
    }
    return startDownload(reply, url.href, { filename: typeof filename === 'string' ? filename : null });
  });

  // ---------- Subtitles (sidecar .srt/.vtt files and text tracks embedded in the video) ----------

  const findMovie = async (id) => (await getInfos()).movies.find((m) => m.id === id);

  app.get('/api/movies/:id/subtitles', { preHandler: requireUser }, async (request, reply) => {
    const movie = await findMovie(request.params.id);
    if (!movie) return reply.code(404).send({ error: 'Film introuvable' });
    return (await subtitles.list(movie)).map(({ id, lang, forced, label }) => ({ id, lang, forced, label }));
  });

  app.get('/api/movies/:id/subtitles/:track', { preHandler: requireUser }, async (request, reply) => {
    const movie = await findMovie(request.params.id);
    const track = movie && (await subtitles.list(movie)).find((t) => t.id === request.params.track);
    if (!track) return reply.code(404).send({ error: 'Sous-titres introuvables' });
    try {
      return reply.type('text/vtt; charset=utf-8').send(await subtitles.read(movie, track));
    } catch (err) {
      request.log.error(err, 'subtitle extraction failed');
      return reply.code(500).send({ error: 'Impossible de lire ces sous-titres' });
    }
  });

  app.get('/api/movies/:id/stream', { preHandler: requireUser }, async (request, reply) => {
    const { movies } = await getInfos();
    const movie = movies.find((m) => m.id === request.params.id);
    if (!movie) return reply.code(404).send({ error: 'Film introuvable' });
    // The file is about to be replaced: don't serve it.
    if (conversions.isBusy(movie.id)) return reply.code(409).send({ error: 'Conversion en cours' });

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
