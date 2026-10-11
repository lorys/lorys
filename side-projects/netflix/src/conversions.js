// Converts movies browsers can't play (container or codecs) to MP4 H.264/AAC, replacing the
// original file. Text subtitles are extracted next to the new file first, since MP4 can't keep them.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { renameMovieEntry, runExclusive } from './scanner.js';
import { describeSubtitle } from './subtitles.js';

const run = promisify(execFile);

export const TEMP_SUFFIX = '.converting';

const MP4_EXTENSIONS = new Set(['.mp4', '.m4v']);
const COPY_AUDIO = new Set(['aac', 'mp3', 'opus']);
const TEXT_SUBTITLES = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const FRENCH = new Set(['fre', 'fra', 'fr']);
const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);
// HDR → SDR BT.709 (needs ffmpeg built with zimg).
const TONEMAP_FILTER =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

function defaultAudio(tracks) {
  const french = tracks.findIndex((s) => FRENCH.has(s.tags?.language?.toLowerCase()));
  if (french !== -1) return french;
  return Math.max(0, tracks.findIndex((s) => s.disposition?.default));
}

/** What to do with a file, from its ffprobe JSON; null when browsers already play it. */
export function planConversion(probe, file) {
  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new Error('Aucune piste vidéo');

  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const defaultIndex = defaultAudio(audioStreams);
  const audio = audioStreams.map((s, i) => {
    const copy = COPY_AUDIO.has(s.codec_name);
    return {
      index: s.index,
      action: copy ? 'copy' : 'aac',
      bitrate: copy ? null : (s.channels ?? 2) > 2 ? '640k' : '256k',
      downmix: !copy && (s.channels ?? 2) > 6,
      isDefault: i === defaultIndex,
    };
  });

  const copyVideo = video.codec_name === 'h264' && video.pix_fmt === 'yuv420p';
  const ext = path.extname(file).toLowerCase();
  if (copyVideo && MP4_EXTENSIONS.has(ext) && audio.every((a) => a.action === 'copy')) return null;

  return {
    videoIndex: video.index,
    video: copyVideo ? 'copy' : 'x264',
    hdr: HDR_TRANSFERS.has(video.color_transfer),
    audio,
    subtitles: streams
      .filter((s) => s.codec_type === 'subtitle' && TEXT_SUBTITLES.has(s.codec_name))
      .map((s) => ({ index: s.index, lang: s.tags?.language ?? null, forced: Boolean(s.disposition?.forced) })),
    duration: Number(probe.format?.duration) || null,
    outputFile: MP4_EXTENSIONS.has(ext) ? file : file.slice(0, file.length - ext.length) + '.mp4',
  };
}

export function ffmpegArgs(plan, inputPath, outputPath, { zscale = false } = {}) {
  const args = ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-i', inputPath, '-map', `0:${plan.videoIndex}`];
  for (const a of plan.audio) args.push('-map', `0:${a.index}`);
  if (plan.video === 'copy') {
    args.push('-c:v', 'copy');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p');
    if (plan.hdr && zscale) {
      args.push('-vf', TONEMAP_FILTER, '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
    }
  }
  plan.audio.forEach((a, i) => {
    if (a.action === 'copy') args.push(`-c:a:${i}`, 'copy');
    else args.push(`-c:a:${i}`, 'aac', `-b:a:${i}`, a.bitrate);
    if (a.downmix) args.push(`-ac:a:${i}`, '6');
    args.push(`-disposition:a:${i}`, a.isDefault ? 'default' : '0');
  });
  args.push('-map_metadata', '0', '-map_chapters', '0', '-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', '-nostats', outputPath);
  return args;
}

/** One ffmpeg pass writing each subtitle track to its own SRT file. */
export function subtitleArgs(inputPath, outputs) {
  const args = ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-i', inputPath];
  for (const o of outputs) args.push('-map', `0:${o.index}`, '-c:s', 'srt', '-f', 'srt', o.path);
  return args;
}

/** Feeds `onSeconds` with the encoded duration from ffmpeg's `-progress` output. */
export function createProgressParser(onSeconds) {
  let pending = '';
  return (chunk) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const match = /^out_time_us=(\d+)$/.exec(line.trim());
      if (match) onSeconds(Number(match[1]) / 1e6);
    }
  };
}

/** "Film.fr.forced.srt" next to `videoFile`, numbered when the name is taken. */
export function subtitleSidecarName(videoFile, track, taken) {
  const base = videoFile.slice(0, videoFile.length - path.extname(videoFile).length);
  const lang = track.lang ? (describeSubtitle([track.lang]).lang ?? track.lang.toLowerCase()) : null;
  const stem = `${base}${lang ? `.${lang}` : ''}${track.forced ? '.forced' : ''}`;
  let name = `${stem}.srt`;
  for (let n = 2; taken.has(name); n++) name = `${stem}.${n}.srt`;
  return name;
}

async function ffprobe(filePath, signal) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath], {
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    signal,
  });
  return JSON.parse(stdout);
}

/** Runs ffmpeg; `onStdout` gets the -progress output. Rejects with ffmpeg's last error line. */
function ffmpeg(args, { signal, onStdout }) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { signal, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', (chunk) => onStdout?.(chunk));
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split('\n').at(-1) || `ffmpeg a échoué (code ${code})`));
    });
  });
}

async function* walkTempFiles(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTempFiles(full);
    else if (entry.name.startsWith('.') && entry.name.endsWith(TEMP_SUFFIX)) yield full;
  }
}

/** Hidden temp name next to `file` (the scanner skips dotfiles). */
function tempPathFor(absolutePath) {
  return path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}${TEMP_SUFFIX}`);
}

const exists = (p) => fs.access(p).then(() => true, () => false);
const statKey = (stat) => `${stat.size}-${stat.mtimeMs}`;

/**
 * convert.json: files known to play in browsers — converted ones (`converted: true`) and those that
 * already did (`converted: false`) — with the size and mtime they had, so they're never checked twice.
 */
export function createConversionTracking(filePath, { logger = console } = {}) {
  let loading = null;
  let saving = Promise.resolve();

  function load() {
    loading ??= fs.readFile(filePath, 'utf8').then(
      (text) => JSON.parse(text).files ?? {},
      (err) => {
        if (err.code !== 'ENOENT') logger.warn(`Cannot read ${filePath} (${err.message}), starting from scratch`);
        return {};
      },
    ).catch((err) => {
      logger.warn(`Cannot parse ${filePath} (${err.message}), starting from scratch`);
      return {};
    });
    return loading;
  }

  return {
    /** True when `file` is recorded with this exact size and mtime. */
    async has(file, stat) {
      const entry = (await load())[file];
      return Boolean(entry) && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs;
    },

    async record(file, stat, { converted, source }) {
      const files = await load();
      files[file] = { size: stat.size, mtimeMs: stat.mtimeMs, converted, ...(source ? { source } : {}), at: new Date().toISOString() };
      saving = saving
        .then(async () => {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          const tmp = `${filePath}.${process.pid}.tmp`;
          await fs.writeFile(tmp, JSON.stringify({ files }, null, 2) + '\n');
          await fs.rename(tmp, filePath);
        })
        .catch((err) => logger.warn(`Cannot write ${filePath}: ${err.message}`));
      return saving;
    },
  };
}

/**
 * Converts movies one at a time. `enqueue` checks movies right away; only movies that need a
 * conversion get a status, which `GET /api/movies` shows to the frontend.
 */
export function createConversionManager(
  config,
  {
    logger = console,
    stableMs = 5_000,
    probe = ffprobe,
    trackingPath = path.join(path.dirname(config.moviesInfosPath), 'convert.json'),
  } = {},
) {
  const { moviesPath } = config;
  const tracking = createConversionTracking(trackingPath, { logger });
  const states = new Map(); // movieId → { id, file, key, status, percent, error }
  const plans = new Map(); // file → { key, plan } (probe cache)
  const queue = [];
  const abort = new AbortController();
  let worker = null;
  let tools = null;

  /** ffmpeg + ffprobe installed? Also whether ffmpeg can tone-map HDR (zscale). */
  function checkTools() {
    tools ??= (async () => {
      try {
        await Promise.all([run('ffmpeg', ['-version']), run('ffprobe', ['-version'])]);
      } catch {
        logger.warn('ffmpeg/ffprobe not found: movies browsers can’t play won’t be converted');
        return null;
      }
      const { stdout } = await run('ffmpeg', ['-hide_banner', '-filters'], { maxBuffer: 4 * 1024 * 1024 });
      const zscale = /\szscale\s/.test(stdout);
      if (!zscale) logger.warn('ffmpeg has no zscale filter: HDR movies will be converted without tone mapping');
      return { zscale };
    })();
    return tools;
  }

  /**
   * Resolves with the file's stat once it hasn't changed for `stableMs` (still being copied or
   * downloaded otherwise). A file not modified for that long is stable right away.
   */
  async function waitUntilStable(full) {
    let before = await fs.stat(full);
    for (;;) {
      if (Date.now() - before.mtimeMs >= stableMs) return before;
      await sleep(stableMs, null, { signal: abort.signal });
      const after = await fs.stat(full);
      // Size and mtime: preallocated files (torrents, rsync --inplace) keep their size while written.
      if (statKey(after) === statKey(before)) return after;
      before = after;
    }
  }

  async function planFor(file, stat) {
    const key = statKey(stat);
    const cached = plans.get(file);
    if (cached?.key === key) return cached.plan;
    const plan = planConversion(await probe(path.join(moviesPath, file), abort.signal), file);
    plans.set(file, { key, plan });
    return plan;
  }

  // Queued/converting movies, and failed ones until their file changes or the server restarts.
  const handled = (movie, key) => {
    const state = states.get(movie.id);
    return Boolean(state) && (state.status !== 'failed' || state.key === key);
  };

  async function enqueue(movie) {
    if (abort.signal.aborted || !(await checkTools())) return;
    const full = path.join(moviesPath, movie.file);
    let stat;
    try {
      stat = await fs.stat(full);
      if (handled(movie, statKey(stat)) || (await tracking.has(movie.file, stat))) return;
      stat = await waitUntilStable(full);
    } catch {
      return; // removed meanwhile, or shutting down
    }
    const key = statKey(stat);
    let plan;
    try {
      plan = await planFor(movie.file, stat);
    } catch (err) {
      if (abort.signal.aborted || handled(movie, key)) return;
      states.set(movie.id, { id: movie.id, file: movie.file, key, status: 'failed', percent: 0, error: 'Fichier illisible' });
      logger.warn(`Cannot probe "${movie.file}": ${err.message}`);
      return;
    }
    // Another enqueue of the same movie may have won while we were waiting or probing.
    if (abort.signal.aborted || handled(movie, key)) return;
    if (!plan) {
      states.delete(movie.id); // a previous failure on an older version of the file
      await tracking.record(movie.file, stat, { converted: false });
      return;
    }
    states.set(movie.id, { id: movie.id, file: movie.file, key, status: 'queued', percent: 0, error: null });
    queue.push(movie.id);
    worker ??= work().finally(() => {
      worker = null;
    });
  }

  async function work() {
    while (queue.length && !abort.signal.aborted) {
      const state = states.get(queue.shift());
      const job = { temps: [] };
      try {
        if ((await convert(state, job)) === 'changed') {
          // The source was replaced meanwhile: start over with the new file.
          Object.assign(state, { status: 'queued', percent: 0 });
          queue.push(state.id);
        } else {
          states.delete(state.id);
        }
      } catch (err) {
        if (abort.signal.aborted) {
          states.delete(state.id);
        } else if (await changedSince(state)) {
          // Failed because the file was being replaced: start over with the new one.
          Object.assign(state, { status: 'queued', percent: 0 });
          queue.push(state.id);
        } else {
          Object.assign(state, { status: 'failed', percent: 0, error: err.message });
          logger.warn(`Conversion failed for "${state.file}": ${err.message}`);
        }
      } finally {
        await Promise.all(job.temps.map((t) => fs.rm(t, { force: true })));
      }
    }
  }

  /** True when the movie's file still exists but isn't the one the conversion started from. */
  async function changedSince(state) {
    const current = await fs.stat(path.join(moviesPath, state.file)).catch(() => null);
    return Boolean(current) && statKey(current) !== state.key;
  }

  /** `wanted`, or "Name (1).mp4"… when another file already has that name. */
  async function freeName(wanted, source) {
    if (wanted === source || !(await exists(path.join(moviesPath, wanted)))) return wanted;
    const ext = path.extname(wanted);
    const stem = wanted.slice(0, wanted.length - ext.length);
    for (let n = 1; ; n++) {
      const name = `${stem} (${n})${ext}`;
      if (!(await exists(path.join(moviesPath, name)))) return name;
    }
  }

  async function verify(outputPath, plan) {
    const { streams = [], format } = await probe(outputPath, abort.signal);
    const videos = streams.filter((s) => s.codec_type === 'video');
    const audios = streams.filter((s) => s.codec_type === 'audio');
    if (videos.length !== 1 || videos[0].codec_name !== 'h264') throw new Error('Piste vidéo invalide après conversion');
    if (audios.length !== plan.audio.length) throw new Error('Pistes audio manquantes après conversion');
    const duration = Number(format?.duration);
    if (plan.duration && !(Math.abs(duration - plan.duration) <= 2)) {
      throw new Error(`Durée différente après conversion (${duration} s au lieu de ${plan.duration} s)`);
    }
  }

  async function convert(state, job) {
    const { zscale } = await checkTools();
    const sourcePath = path.join(moviesPath, state.file);
    // The file may have changed while it was queued.
    const source = await waitUntilStable(sourcePath);
    const plan = await planFor(state.file, source);
    if (!plan) return;
    state.key = statKey(source);
    state.status = 'converting';
    logger.info(`Converting "${state.file}" (video: ${plan.video}, audio: ${plan.audio.map((a) => a.action).join('/') || 'none'})`);

    // Final names are only picked when swapping (step 4): files can appear during a long encode.
    const tempBase = path.join(moviesPath, plan.outputFile);

    // 1. Text subtitles → sidecar .srt files (MP4 can't keep them).
    const sidecars = plan.subtitles.map((track, i) => ({ ...track, path: tempPathFor(`${tempBase}.${i}.srt`) }));
    job.temps.push(...sidecars.map((s) => s.path));
    if (sidecars.length) await ffmpeg(subtitleArgs(sourcePath, sidecars), { signal: abort.signal });

    // 2. Audio/video into a hidden temp file.
    const tempPath = tempPathFor(tempBase);
    job.temps.push(tempPath);
    const onProgress = createProgressParser((seconds) => {
      if (plan.duration) state.percent = Math.min(99, Math.floor((seconds / plan.duration) * 100));
    });
    await ffmpeg(ffmpegArgs(plan, sourcePath, tempPath, { zscale }), { signal: abort.signal, onStdout: onProgress });

    // 3. Check the result before throwing the original away.
    await verify(tempPath, plan);
    await fs.utimes(tempPath, source.atime, source.mtime); // keeps its place in "Ajoutés récemment"

    // 4. Swap files and update movies.json together, so a scan never sees half of it.
    const outputFile = await runExclusive(async () => {
      const current = await fs.stat(sourcePath).catch(() => null);
      if (!current) return null; // deleted meanwhile: nothing to replace
      if (statKey(current) !== state.key) return 'changed';
      const output = await freeName(plan.outputFile, state.file);
      const dir = path.posix.dirname(output);
      const taken = new Set(
        (await fs.readdir(path.dirname(path.join(moviesPath, output)))).map((name) => (dir === '.' ? name : `${dir}/${name}`)),
      );
      for (const s of sidecars) {
        const name = subtitleSidecarName(output, s, taken);
        taken.add(name);
        await fs.rename(s.path, path.join(moviesPath, name));
      }
      await fs.rename(tempPath, path.join(moviesPath, output));
      if (output !== state.file) {
        await fs.rm(sourcePath, { force: true });
        await renameMovieEntry(config, state.file, output);
      }
      return output;
    });
    plans.delete(state.file);
    if (outputFile === 'changed') return 'changed';
    if (!outputFile) return;
    const outputPath = path.join(moviesPath, outputFile);

    // 5. Never check this file again (unless it changes).
    await tracking.record(outputFile, await fs.stat(outputPath), { converted: true, source: state.file });
    logger.info(`Converted "${state.file}" → "${outputFile}"`);
  }

  const view = ({ status, percent, error }) => ({ status, percent, error });

  return {
    enqueue,

    status(id) {
      const state = states.get(id);
      return state ? view(state) : null;
    },

    list() {
      return Object.fromEntries([...states.values()].map((s) => [s.id, view(s)]));
    },

    isBusy(id) {
      return ['queued', 'converting'].includes(states.get(id)?.status);
    },

    /** Resolves once nothing is queued or converting. */
    async idle() {
      while (worker) await worker;
    },

    /** Removes temp files left by a crash; returns how many. */
    async cleanup() {
      let removed = 0;
      for await (const file of walkTempFiles(moviesPath)) {
        try {
          await fs.rm(file, { force: true });
          removed++;
        } catch (err) {
          logger.warn(`Cannot remove leftover conversion file ${file}: ${err.message}`); // e.g. read-only library
        }
      }
      if (removed) logger.info(`Removed ${removed} leftover conversion file(s)`);
      return removed;
    },

    /** Stops the running ffmpeg (its temp files are deleted) and forgets the queue. */
    async close() {
      abort.abort();
      queue.length = 0;
      await worker;
    },
  };
}
