import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline, Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { authenticate, createAccountsStore } from './accounts.js';
import { createCastToken, createSessionToken, readCastToken, readSessionToken, SESSION_COOKIE, SESSION_TTL_MS } from './session.js';
import { deleteLibraryItems, readMoviesInfos, recordAddedBy, rematchMovie, rematchShow } from './scanner.js';
import { createConversionManager } from './conversions.js';
import { createDownloadManager, diskUsage, DownloadRefusedError } from './downloads.js';
import { createSubtitlesService } from './subtitles.js';
import { COMMENT_MAX_LENGTH, createCommentsStore } from './comments.js';
import { addAMovie } from './addAMovie.js';
import { addASerie } from './addASerie.js';
import { log, silentLog } from './log.js';
import { requestLogDetails } from './requestLog.js';

// Movies found by addAMovie() and seasons found by addASerie() wait this long for the user to pick one and confirm the download.
const PENDING_MOVIE_TTL_MS = 15 * 60_000;

// A user counts as watching while their player saved progress this recently (it saves every 10 s).
const WATCHING_TTL_MS = 30_000;

// A cast receiver (TV) counts as watching while it pulled video through its cast link this recently.
// Receivers fill a buffer and then pause their downloads, so this is longer than WATCHING_TTL_MS.
const CAST_WATCHING_TTL_MS = 2 * 60_000;

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

// `logger`: a pino-style logger, true for the console one (src/log.js), false for none.
export function buildApp(config, { logger = true, conversions, tmdb, loginIntervalMs = LOGIN_INTERVAL_MS } = {}) {
  const loggerInstance = logger === true ? log : logger || silentLog;
  // Fastify's own request logs are replaced by ours (see "Request logs" below).
  const app = Fastify({ loggerInstance, logController: new LogController({ disableRequestLogging: true }) });
  const getInfos = createInfosCache(config.moviesInfosPath);
  const accounts = createAccountsStore(config.accountsPath, config.accountsSecret);
  const downloads = createDownloadManager(config.moviesPath, {
    logger: app.log,
    recordAddedBy: (file, username) => recordAddedBy(config, file, username),
  });
  conversions ??= createConversionManager(config, { logger: app.log });
  app.decorate('conversions', conversions);
  const comments = createCommentsStore(path.join(path.dirname(config.moviesInfosPath), 'comments.json'));
  const subtitles = createSubtitlesService(config.moviesPath, path.join(path.dirname(config.moviesInfosPath), 'subtitles'));
  app.addHook('onClose', () => downloads.close());
  app.addHook('onClose', () => conversions.close());

  app.addHook('onSend', async (request, reply, payload) => {
    reply.headers(SECURITY_HEADERS);
    if (reply.statusCode >= 400 && typeof payload === 'string') {
      try {
        request.failure = JSON.parse(payload).error ?? payload;
      } catch {
        request.failure = payload;
      }
    }
  });

  // ---------- Request logs: one per request, once its response is over ----------

  // Fastify's own crash log goes away with its request logs: crashes keep their stack here.
  app.addHook('onError', async (request, reply, error) => {
    if ((error.statusCode ?? 500) >= 500) app.log.error(error, 'Request crashed');
  });

  // On 'close' rather than onResponse: also fires when the client hangs up mid-response
  // (players often drop a video request to seek or once their buffer is full).
  app.addHook('onRequest', async (request, reply) => {
    reply.raw.once('close', () => {
      const findMovie = async (id) => (await getInfos()).movies.find((m) => m.id === id);
      requestLogDetails(request, reply, { findMovie })
        .then(({ sentence, data }) => (reply.statusCode >= 500 ? app.log.error : app.log.info)(data, sentence))
        .catch((err) => app.log.error(err, 'Request log failed'));
    });
  });

  app.register(fastifyCookie);
  app.register(fastifyStatic, { root: PUBLIC_DIR });

  // `session` is what the cookie claims; `user` is only set once requireUser checked it against the account.
  app.decorateRequest('session', null);
  app.decorateRequest('user', null);
  app.decorateRequest('viaCast', false);
  // Why a cast link was refused, and the error message sent back: shown in the request log.
  app.decorateRequest('castRefused', null);
  app.decorateRequest('failure', null);
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

  // Latest cast link nonce per user: creating a new cast link cancels the previous one. Kept in
  // memory, so a restart cancels them all (the player just asks for a new one on the next cast).
  const castNonces = new Map();

  // The stream accepts a cast link (`?cast=`, for the TV that has no cookie) or the session cookie.
  const requireStreamAccess = async (request, reply) => {
    if (request.query.cast !== undefined) {
      const cast = readCastToken(request.query.cast, config.sessionSecret);
      const account = cast && (await accounts.read()).find((a) => a.username === cast.username);
      if (!cast) request.castRefused = 'invalid or expired cast link';
      else if (cast.movieId !== request.params.id) request.castRefused = 'cast link made for another movie';
      else if (!castNonces.has(cast.username)) request.castRefused = 'cast link forgotten (server restarted)';
      else if (castNonces.get(cast.username) !== cast.nonce) request.castRefused = 'replaced by a newer cast link';
      else if (!account) request.castRefused = 'account deleted';
      else if ((account.sessionVersion ?? 0) !== cast.version) request.castRefused = 'sessions revoked (logout or password change)';
      else {
        request.user = account.username;
        request.viaCast = true;
        return;
      }
    }
    return requireUser(request, reply);
  };

  const isAdmin = (username) => Boolean(config.admin) && username === config.admin;

  const requireAdmin = async (request, reply) => {
    await requireUser(request, reply);
    if (reply.sent) return;
    if (!isAdmin(request.user)) return reply.code(403).send({ error: 'Réservé à l’administrateur' });
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
      return { username: user.username, admin: isAdmin(user.username) };
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

  app.get('/api/me', { preHandler: requireUser }, async (request) => ({ username: request.user, admin: isAdmin(request.user) }));

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
  // username → { movieId, ratio, at }: last video bytes sent through a cast link, and where they sit
  // in the file. While the phone that started the cast is locked, its player saves nothing: the
  // TV's downloads are then the only sign that someone is watching.
  const castActivity = new Map();

  /** Passes the stream through, recording the cast receiver's activity at each chunk it pulls. */
  function trackCast(username, movieId, stream, start, size) {
    let offset = start;
    const tap = new Transform({
      transform(chunk, encoding, callback) {
        offset += chunk.length;
        castActivity.set(username, { movieId, ratio: offset / size, at: Date.now() });
        callback(null, chunk);
      },
    });
    return pipeline(stream, tap, () => {});
  }

  app.get('/api/watching', { preHandler: requireUser }, async () => {
    const { movies } = await getInfos();
    const byId = new Map(movies.map((m) => [m.id, m]));
    const now = Date.now();
    const watchers = new Map();
    for (const [username, entry] of lastProgress) {
      if (now - entry.updatedAt < WATCHING_TTL_MS && byId.has(entry.movieId)) watchers.set(username, entry);
    }
    // Casting with no recent save from the player: the position is estimated from the bytes the TV
    // is reading (a bit ahead of what is on screen, by the receiver's buffer).
    let accountsList = null;
    for (const [username, cast] of castActivity) {
      if (watchers.has(username) || now - cast.at >= CAST_WATCHING_TTL_MS || !byId.has(cast.movieId)) continue;
      const saved = lastProgress.get(username);
      accountsList ??= await accounts.read();
      const duration =
        (saved?.movieId === cast.movieId && saved.duration) ||
        accountsList.find((a) => a.username === username)?.progress?.[cast.movieId]?.duration ||
        (byId.get(cast.movieId).runtime ?? 0) * 60 ||
        null;
      watchers.set(username, {
        movieId: cast.movieId,
        position: duration ? Math.round(Math.min(1, cast.ratio) * duration) : null,
        duration,
        updatedAt: cast.at,
      });
    }
    return [...watchers].map(([username, entry]) => ({ username, ...entry }));
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
      // Finished: the TV's last downloads must not keep showing it as being watched.
      if (!entry && castActivity.get(request.user)?.movieId === request.params.id) castActivity.delete(request.user);
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
  const startDownload = async (request, reply, href, options) => {
    try {
      return reply.code(201).send(await downloads.start(href, { ...options, addedBy: request.user }));
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
      return startDownload(request, reply, url.href);
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
    return startDownload(request, reply, url.href, { filename: typeof filename === 'string' ? filename : null });
  });

  // ---------- Adding a whole season of a series by its exact name ----------

  // Two calls to addASerie(): addASerie(name, season) lists the series matching the name ([{ name, img }]),
  // then addASerie(name, season, type, index) finds the season of the picked series, whose `download` callback gives one link per episode.
  // Series listed by the same search share a `search` id, so confirming one discards the others.
  const SERIE_TYPES = ['VOSTFR', 'VF', 'VO', 'VF HD'];
  const pendingSeasons = new Map(); // token → { username, search, name, season, type, index, expiresAt }

  const prunePendingSeasons = () => {
    for (const [token, pending] of pendingSeasons) {
      if (pending.expiresAt < Date.now()) pendingSeasons.delete(token);
    }
  };

  app.post('/api/add-serie', {
    preHandler: requireUser,
    schema: {
      body: {
        type: 'object',
        required: ['name', 'season', 'type'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 300 },
          season: { type: 'integer', minimum: 0, maximum: 1000 },
          type: { type: 'string', enum: SERIE_TYPES },
        },
      },
    },
    handler: async (request, reply) => {
      const name = request.body.name.trim();
      const { season, type } = request.body;
      if (!name) return reply.code(400).send({ error: 'Indiquez le nom de la série' });
      let found;
      try {
        found = await addASerie(name, season);
      } catch (err) {
        request.log.error(err, 'addASerie failed');
        return reply.code(502).send({ error: 'La recherche de la série a échoué' });
      }
      if (found && !Array.isArray(found) && found.ok === false && found.error !== 'not found') {
        return reply.code(404).send({ error: String(found.error) });
      }
      if (found && !Array.isArray(found) && found.ok !== false) {
        request.log.error('addASerie returned something else than a list of series');
        return reply.code(502).send({ error: 'La recherche de la série a échoué' });
      }
      // Keep each series' index in the list given by addASerie(): it identifies the series in the second call.
      const choices = (Array.isArray(found) ? found : []).map((serie, index) => ({ serie, index })).filter(({ serie }) => serie);
      if (!choices.length) return reply.code(404).send({ error: `Aucune série trouvée pour « ${name} »` });
      prunePendingSeasons();
      const search = crypto.randomBytes(12).toString('hex');
      const expiresAt = Date.now() + PENDING_MOVIE_TTL_MS;
      return {
        season,
        type,
        series: choices.map(({ serie, index }) => {
          const token = crypto.randomBytes(12).toString('hex');
          pendingSeasons.set(token, { username: request.user, search, name, season, type, index, expiresAt });
          return { token, serieName: typeof serie.name === 'string' ? serie.name : name, imgUrl: typeof serie.img === 'string' ? serie.img : null };
        }),
      };
    },
  });

  // Finds the season of the picked series, then starts one download per episode.
  // 201 as soon as one started; `failed` lists the episodes that didn't.
  app.post('/api/add-serie/:token/download', { preHandler: requireUser }, async (request, reply) => {
    prunePendingSeasons();
    const pending = pendingSeasons.get(request.params.token);
    if (!pending || pending.username !== request.user) {
      return reply.code(404).send({ error: 'Cette recherche a expiré, recommencez' });
    }
    for (const [token, other] of pendingSeasons) {
      if (other.search === pending.search) pendingSeasons.delete(token);
    }
    const { name, season, type, index } = pending;
    let found;
    try {
      found = await addASerie(name, season, type, index);
    } catch (err) {
      request.log.error(err, 'addASerie failed');
      return reply.code(502).send({ error: 'La recherche de la saison a échoué' });
    }
    if (found && found.ok === false && found.error !== 'not found') {
      return reply.code(404).send({ error: String(found.error) });
    }
    if (typeof found?.download !== 'function') {
      if (found && found.ok !== false) {
        request.log.error('addASerie returned a season without a download callback');
        return reply.code(502).send({ error: 'La recherche de la saison a échoué' });
      }
      return reply.code(404).send({ error: `Aucune saison ${season} en ${type} trouvée pour cette série` });
    }
    let episodes;
    try {
      episodes = await found.download();
    } catch (err) {
      request.log.error(err, 'addASerie download callback failed');
      return reply.code(502).send({ error: "Impossible d'obtenir les liens des épisodes" });
    }
    if (!Array.isArray(episodes) || !episodes.filter(Boolean).length) {
      request.log.error({ episodes }, 'addASerie returned no episode links');
      return reply.code(502).send({ error: "Aucun lien d'épisode n'a été obtenu" });
    }
    const started = [];
    const failed = [];
    let refused = null;
    for (const { link, filename } of episodes.filter(Boolean)) {
      const label = typeof filename === 'string' ? filename : String(link);
      let url;
      try {
        url = new URL(String(link));
      } catch {}
      if (!url || !['http:', 'https:'].includes(url.protocol)) {
        request.log.error({ link }, 'addASerie returned an invalid link');
        failed.push({ filename: label, error: 'Lien de téléchargement invalide' });
        continue;
      }
      try {
        started.push(await downloads.start(url.href, { filename: typeof filename === 'string' ? filename : null, addedBy: request.user }));
      } catch (err) {
        if (!(err instanceof DownloadRefusedError)) throw err;
        refused ??= err;
        failed.push({ filename: label, error: err.message });
      }
    }
    if (!started.length) {
      if (refused) return reply.code(refused.statusCode).send({ error: refused.message });
      return reply.code(502).send({ error: 'Les liens de téléchargement obtenus sont invalides' });
    }
    return reply.code(201).send({ started, failed });
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

  // ---------- Comments in the movie and series popups ----------

  const commentBody = {
    type: 'object',
    required: ['text'],
    properties: { text: { type: 'string', minLength: 1, maxLength: COMMENT_MAX_LENGTH } },
  };

  // `find` tells whether the movie or show exists; comments of items no longer in the library aren't served.
  const commentRoutes = (prefix, find, itemKey, missingError) => {
    app.get(`${prefix}/comments`, { preHandler: requireUser }, async (request, reply) => {
      if (!(await find(request.params))) return reply.code(404).send({ error: missingError });
      return comments.list(itemKey(request.params));
    });
    app.post(`${prefix}/comments`, { preHandler: requireUser, schema: { body: commentBody } }, async (request, reply) => {
      const text = request.body.text.trim();
      if (!text) return reply.code(400).send({ error: 'Le commentaire est vide' });
      if (!(await find(request.params))) return reply.code(404).send({ error: missingError });
      return reply.code(201).send(await comments.add(itemKey(request.params), request.user, text));
    });
  };

  commentRoutes(
    '/api/movies/:id',
    async ({ id }) => (await getInfos()).movies.some((m) => m.id === id && m.kind !== 'episode'),
    ({ id }) => `movie:${id}`,
    'Film introuvable',
  );
  commentRoutes(
    '/api/shows/:key',
    async ({ key }) => (await getInfos()).movies.some((m) => m.kind === 'episode' && m.showKey === key),
    ({ key }) => `show:${key}`,
    'Série introuvable',
  );

  // ---------- Fixing the TMDB match by name and deleting (admin only) ----------

  const matchBody = {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string', minLength: 1, maxLength: 300 } },
  };

  const rematch = async (request, reply, lookUp, missingError) => {
    const name = request.body.name.trim();
    if (!name) return reply.code(400).send({ error: 'Indiquez le nom exact' });
    let result;
    try {
      result = await lookUp(name);
    } catch (err) {
      request.log.error(err, 'TMDB rematch failed');
      return reply.code(502).send({ error: 'La recherche sur TMDB a échoué' });
    }
    if (result.missing) return reply.code(404).send({ error: missingError });
    if (result.noMatch) return reply.code(404).send({ error: `TMDB ne trouve rien pour « ${name} »` });
    const { parsed, size, ...item } = result.item;
    return item;
  };

  app.post('/api/movies/:id/match', { preHandler: requireAdmin, schema: { body: matchBody } }, async (request, reply) =>
    rematch(request, reply, (name) => rematchMovie(config, request.params.id, name, { tmdb, logger: request.log }), 'Film introuvable'),
  );

  app.post('/api/shows/:key/match', { preHandler: requireAdmin, schema: { body: matchBody } }, async (request, reply) =>
    rematch(request, reply, (name) => rematchShow(config, request.params.key, name, { tmdb, logger: request.log }), 'Série introuvable'),
  );

  // Removes the files from MOVIES_PATH for good, not only from the catalogue.
  const deleteItems = async (request, reply, items) => {
    if (items.some((m) => conversions.isBusy(m.id))) return reply.code(409).send({ error: 'Conversion en cours, réessayez plus tard' });
    const deleted = await deleteLibraryItems(config, items.map((m) => m.id));
    request.log.info({ user: request.user, files: deleted.map((m) => m.file) }, 'Deleted from the library');
    return { deleted: deleted.length };
  };

  app.delete('/api/movies/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const movie = (await getInfos()).movies.find((m) => m.id === request.params.id && m.kind !== 'episode');
    if (!movie) return reply.code(404).send({ error: 'Film introuvable' });
    return deleteItems(request, reply, [movie]);
  });

  app.delete('/api/shows/:key', { preHandler: requireAdmin }, async (request, reply) => {
    const episodes = (await getInfos()).movies.filter((m) => m.kind === 'episode' && m.showKey === request.params.key);
    if (!episodes.length) return reply.code(404).send({ error: 'Série introuvable' });
    return deleteItems(request, reply, episodes);
  });

  // Called when the user clicks the cast button: a stream URL the receiver can open without the cookie.
  app.post('/api/movies/:id/cast', { preHandler: requireUser }, async (request, reply) => {
    const { movies } = await getInfos();
    const movie = movies.find((m) => m.id === request.params.id);
    if (!movie) return reply.code(404).send({ error: 'Film introuvable' });
    const account = (await accounts.read()).find((a) => a.username === request.user);
    const nonce = crypto.randomBytes(16).toString('base64url');
    castNonces.set(request.user, nonce);
    const token = createCastToken(
      { movieId: movie.id, username: request.user, version: account.sessionVersion ?? 0, nonce },
      config.sessionSecret,
    );
    return { url: `/api/movies/${encodeURIComponent(movie.id)}/stream?cast=${token}` };
  });

  app.get('/api/movies/:id/stream', { preHandler: requireStreamAccess }, async (request, reply) => {
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
      const stream = fs.createReadStream(filePath);
      return reply.send(request.viaCast ? trackCast(request.user, movie.id, stream, 0, stat.size) : stream);
    }
    const range = parseRange(request.headers.range, stat.size);
    if (!range) {
      return reply.code(416).header('Content-Range', `bytes */${stat.size}`).send();
    }
    reply
      .code(206)
      .header('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`)
      .header('Content-Length', range.end - range.start + 1);
    const stream = fs.createReadStream(filePath, range);
    return reply.send(request.viaCast ? trackCast(request.user, movie.id, stream, range.start, stat.size) : stream);
  });

  return app;
}
