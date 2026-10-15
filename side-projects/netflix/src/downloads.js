// Downloads movies from a URL straight into MOVIES_PATH. Data goes to "<name>.part" and is
// renamed once complete, so the watcher only ever sees finished video files.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { VIDEO_EXTENSIONS } from './filename.js';

const PART_SUFFIX = '.part';
// Finished, failed and cancelled downloads stay listed this long.
const KEEP_DONE_MS = 60 * 60_000;

const GB = 1024 ** 3;
// Limits that keep downloads from filling the disk (all users together).
const MAX_RUNNING = 20;
const MAX_SIZE = 10 * GB;
// No new download below this much free space…
const MIN_FREE_START = 10 * GB;
// …and a file of known size must leave this much free once it and the other running downloads are done.
const FREE_MARGIN = 1 * GB;

const EXTENSION_BY_TYPE = {
  'video/mp4': '.mp4',
  'video/x-m4v': '.m4v',
  'video/x-matroska': '.mkv',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/ogg': '.ogv',
};

/** A download refused before it starts; `statusCode` is the HTTP status to answer with. */
export class DownloadRefusedError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Disk usage of the filesystem holding `dir`, in bytes. */
export async function diskUsage(dir) {
  const { blocks, bfree, bavail, bsize } = await fsp.statfs(dir);
  const used = (blocks - bfree) * bsize;
  // Same formula as `df`: reserved blocks count neither as used nor as available.
  const usedPercent = Math.ceil((used / (used + bavail * bsize)) * 100);
  return { total: blocks * bsize, used, available: bavail * bsize, usedPercent };
}

/** Filename from a Content-Disposition header, or null. */
export function filenameFromDisposition(header) {
  if (!header) return null;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[2].trim().replace(/^"|"$/g, ''));
    } catch {}
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  return plain ? (plain[1] ?? plain[2]).trim() : null;
}

/** Last path segment of a URL, decoded, or null. */
export function filenameFromUrl(url) {
  const segment = new URL(url).pathname.split('/').filter(Boolean).at(-1);
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Pick a safe video filename for a response: the caller's `name` first, then
 * Content-Disposition, then the URL. Returns null when the response doesn't look like a video.
 */
export function pickFilename({ name: preferred, disposition, url, contentType }) {
  const raw = preferred || filenameFromDisposition(disposition) || filenameFromUrl(url) || 'film';
  let name = path
    .basename(raw.replace(/\\/g, '/'))
    .replace(/[\x00-\x1f<>:"|?*]/g, '')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 200);
  if (!name) name = 'film';
  if (VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase())) return name;
  const ext = EXTENSION_BY_TYPE[(contentType ?? '').split(';')[0].trim().toLowerCase()];
  return ext ? name + ext : null;
}

export function createDownloadManager(
  moviesPath,
  { logger = console, maxRunning = MAX_RUNNING, maxSize = MAX_SIZE, minFreeStart = MIN_FREE_START, freeMargin = FREE_MARGIN } = {},
) {
  const downloads = new Map(); // id → download
  const reserved = new Set(); // filenames claimed by running downloads

  const running = () => [...downloads.values()].filter((d) => d.status === 'downloading');

  async function exists(file) {
    return fsp.access(file).then(
      () => true,
      () => false,
    );
  }

  /** "Film.mkv", then "Film (1).mkv", "Film (2).mkv"… whichever is free. */
  async function claimFilename(name) {
    const ext = path.extname(name);
    const base = name.slice(0, -ext.length);
    for (let i = 0; ; i++) {
      const candidate = i ? `${base} (${i})${ext}` : name;
      const full = path.join(moviesPath, candidate);
      if (reserved.has(candidate) || (await exists(full)) || (await exists(full + PART_SUFFIX))) continue;
      reserved.add(candidate);
      return candidate;
    }
  }

  function prune() {
    const limit = Date.now() - KEEP_DONE_MS;
    for (const [id, d] of downloads) {
      if (d.status !== 'downloading' && d.finishedAt < limit) downloads.delete(id);
    }
  }

  async function run(download) {
    let partPath = null;
    try {
      const res = await fetch(download.url, { signal: download.controller.signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`Le serveur a répondu ${res.status}`);
      const name = pickFilename({
        name: download.preferredName,
        disposition: res.headers.get('content-disposition'),
        url: res.url || download.url,
        contentType: res.headers.get('content-type'),
      });
      if (!name) throw new Error("Ce lien ne pointe pas vers un fichier vidéo");

      const total = Number(res.headers.get('content-length')) || null;
      if (total > maxSize) {
        res.body.cancel().catch(() => {});
        throw new Error(`Fichier trop volumineux (${maxSize / GB} Go maximum)`);
      }
      if (total) {
        // Bytes the other running downloads of known size still have to write.
        const pending = running()
          .filter((d) => d !== download && d.total)
          .reduce((sum, d) => sum + Math.max(0, d.total - d.received), 0);
        if ((await diskUsage(moviesPath)).available < total + pending + freeMargin) {
          res.body.cancel().catch(() => {});
          throw new Error("Pas assez d'espace disque pour ce fichier");
        }
      }

      download.filename = await claimFilename(name);
      download.total = total;
      const finalPath = path.join(moviesPath, download.filename);
      partPath = finalPath + PART_SUFFIX;

      const count = new Transform({
        transform(chunk, _encoding, callback) {
          download.received += chunk.length;
          if (download.received > maxSize) return callback(new Error(`Fichier trop volumineux (${maxSize / GB} Go maximum)`));
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), count, fs.createWriteStream(partPath, { flags: 'wx' }), {
        signal: download.controller.signal,
      });
      await fsp.rename(partPath, finalPath);
      download.status = 'done';
      logger.info(`Download finished: ${download.filename}`);
    } catch (err) {
      if (partPath) await fsp.rm(partPath, { force: true });
      if (download.controller.signal.aborted) {
        download.status = 'cancelled';
      } else {
        download.status = 'error';
        download.error = err.message;
        logger.warn(`Download failed (${download.url}): ${err.message}`);
      }
    } finally {
      reserved.delete(download.filename);
      download.finishedAt = Date.now();
    }
  }

  function toJSON({ controller, finishedAt, done, preferredName, ...download }) {
    return download;
  }

  return {
    /**
     * Start downloading `url` in the background; resolves with the new download.
     * `filename` overrides the name the server would give the file.
     * Rejects with a DownloadRefusedError when too many downloads run or the disk is almost full.
     */
    async start(url, { filename = null } = {}) {
      if ((await diskUsage(moviesPath)).available < minFreeStart) {
        throw new DownloadRefusedError('Espace disque insuffisant pour lancer un téléchargement', 507);
      }
      prune();
      // Checked after the await so concurrent requests can't all slip through.
      if (running().length >= maxRunning) {
        throw new DownloadRefusedError(`Trop de téléchargements en cours (${maxRunning} maximum), réessayez plus tard`, 429);
      }
      const download = {
        id: crypto.randomBytes(6).toString('hex'),
        url,
        filename: null,
        preferredName: filename,
        received: 0,
        total: null,
        status: 'downloading',
        error: null,
        startedAt: new Date().toISOString(),
        controller: new AbortController(),
        finishedAt: 0,
      };
      downloads.set(download.id, download);
      download.done = run(download);
      return toJSON(download);
    },

    list() {
      prune();
      return [...downloads.values()].map(toJSON);
    },

    /** Cancel a running download, or forget a finished one. Returns false if unknown. */
    remove(id) {
      const download = downloads.get(id);
      if (!download) return false;
      if (download.status === 'downloading') download.controller.abort();
      else downloads.delete(id);
      return true;
    },

    /** For tests and shutdown: resolves once `id` has settled. */
    async settled(id) {
      await downloads.get(id)?.done;
    },

    close() {
      for (const d of downloads.values()) d.controller.abort();
      return Promise.all([...downloads.values()].map((d) => d.done));
    },
  };
}
