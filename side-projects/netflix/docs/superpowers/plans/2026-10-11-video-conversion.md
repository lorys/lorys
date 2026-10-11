# Automatic Video Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect movies browsers can't play, convert them in the background to MP4 (H.264 + AAC) replacing the original file, and show "Conversion en cours (X %)" in the frontend meanwhile.

**Architecture:** A new `src/conversions.js` holds pure planning helpers (ffprobe JSON → plan → ffmpeg args) and a conversion manager (in-memory queue, one ffmpeg at a time, progress from `-progress pipe:1`, files already handled tracked in `convert.json`), built like `src/downloads.js` and created inside `buildApp`. A module-level lock in `src/scanner.js` serialises library changes so the file swap + `movies.json` update never race a scan. The watcher reports newly added movies; `src/index.js` enqueues the library at startup and new movies after each scan. The API exposes the status, the frontend polls it.

**Tech Stack:** Node ≥ 22.9 (ESM), Fastify 5, `node:test`, ffmpeg/ffprobe CLI (child processes), vanilla JS frontend.

**Spec:** `docs/superpowers/specs/2026-10-11-video-conversion-design.md`

## Spec adjustments (decided while planning)

- The lock lives in `src/scanner.js` (`runExclusive`) instead of being exposed by the watcher: the manager is created in `buildApp` (like downloads), before the watcher exists, so a shared module-level lock avoids a circular dependency. The watcher wraps its check in it.
- The watcher's callback is `onScanned(addedMovies)` with only the movies the scan added, so `CONVERT_ON_START=false` really leaves the existing library alone.
- `parseProgress` becomes `createProgressParser(onSeconds)` to handle chunks split mid-line.
- The converted file gets the original's mtime, so the movie keeps its place in "Ajoutés récemment".
- A `failed` movie stays playable (the server only refuses `queued`/`converting`); the modal shows the error.

## Global Constraints

- Node ≥ 22.9, ESM, no new npm dependencies; ffmpeg/ffprobe are called as CLI tools.
- Target: MP4 container (`-f mp4 -movflags +faststart`); `.mp4`/`.m4v` keep their extension, everything else becomes `.mp4`.
- Video: copy only `h264` with `pix_fmt` `yuv420p`; otherwise `libx264 -preset slow -crf 18 -pix_fmt yuv420p`, same resolution and frame rate.
- HDR (`color_transfer` `smpte2084` or `arib-std-b67`): tone-map to SDR BT.709 with zscale + tonemap when ffmpeg has `zscale`; without it, convert to `yuv420p` as is and log a warning.
- Audio: keep every track; copy `aac`, `mp3`, `opus`; re-encode the rest to AAC, 256k for ≤ 2 channels, 640k above; more than 6 channels → `-ac 6`.
- Default audio: first track with language `fre`/`fra`/`fr`, else the source's default track, else the first.
- Text subtitle codecs extracted to `.srt` sidecars: `subrip`, `srt`, `ass`, `ssa`, `mov_text`, `webvtt`, `text`. Bitmap tracks, attachments, data streams and cover images are dropped.
- One conversion at a time. Temp files start with `.` and end with `.converting`.
- Stable files only: a file is probed/converted only once its size hasn't changed for 5 s (`stableMs = 5_000`); a file whose mtime is older than 5 s is stable right away.
- `convert.json` at `path.join(path.dirname(config.moviesInfosPath), 'convert.json')`: `{ "files": { "<relative path>": { size, mtimeMs, converted: boolean, source?, at } } }`; `converted: false` = already compatible. An entry counts only when `size` and `mtimeMs` match the file; failures aren't recorded.
- Verification before replacing: exactly one `h264` video stream, as many audio streams as planned, duration within 2 s of the source.
- `CONVERT_ON_START` env var, default `true` (`env.CONVERT_ON_START !== 'false'`).
- User-facing strings are French: "En attente de conversion", "Conversion en cours (42 %)", "Échec de la conversion", HTTP 409 `{ error: 'Conversion en cours' }`.
- Code style: match the existing code (2-space indent, single quotes, short JSDoc comments, French UI text, English code/comments).

## Review Focus

1. **File still being written** (copied by hand into `MOVIES_PATH`) — must not be probed or converted (and deleted) until its size stopped changing for 5 s. Test in Task 4 (`converts a file only once its size is stable`).
2. **`Film.mp4` already exists next to `Film.mkv`** — the converted file must not overwrite the other movie. Test in Task 4 (`never overwrites another file`).
3. **Server stopped mid-conversion** — original intact, no temp file left, and a leftover temp file from a crash is cleaned at startup. Test in Task 4 (`close() kills ffmpeg…`, `cleanup() removes leftovers`).
4. **Corrupted/unreadable file** — original kept, status `failed`, the queue moves on to the next movie. Test in Task 4 (`a broken file fails…`).
5. **Same movie enqueued twice concurrently** (startup enqueue + watcher `onScanned`) — converted only once. Test in Task 4 (`enqueue is idempotent`).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/conversions.js` (new) | Pure helpers (`planConversion`, `ffmpegArgs`, `subtitleArgs`, `createProgressParser`, `subtitleSidecarName`) + `createConversionManager` |
| `src/scanner.js` | + `runExclusive(fn)` lock, + `renameMovieEntry(config, oldFile, newFile)` |
| `src/watcher.js` | Check runs under `runExclusive`; `onScanned(addedMovies)` callback |
| `src/app.js` | Creates/receives the manager; `conversion` field, `GET /api/conversions`, 409 on stream |
| `src/config.js`, `src/index.js` | `convertOnStart`; startup cleanup, enqueue library, wire watcher |
| `public/index.html`, `public/js/app.js`, `public/css/style.css` | Card overlay, modal state, hero filter, polling |
| `test/conversions.test.js` (new) | Unit + integration tests for conversion, lock, rename, watcher |
| `test/backend.test.js` | API tests with a fake manager |
| `README.md`, `Dockerfile`, `.env.example` | Docs |

---

### Task 1: Pure planning helpers

**Files:**
- Create: `src/conversions.js`
- Test: `test/conversions.test.js`

**Interfaces:**
- Consumes: `describeSubtitle(tokens)` from `src/subtitles.js` (returns `{ lang, forced, sdh }`, maps `fre` → `fr`).
- Produces:
  - `planConversion(probe, file)` → `null` or `Plan`:
    `{ videoIndex: number, video: 'copy'|'x264', hdr: boolean, audio: [{ index, action: 'copy'|'aac', bitrate: string|null, downmix: boolean, isDefault: boolean }], subtitles: [{ index, lang: string|null, forced: boolean }], duration: number|null, outputFile: string }`. Throws `Error('Aucune piste vidéo')` when there's no video stream.
  - `ffmpegArgs(plan, inputPath, outputPath, { zscale = false } = {})` → `string[]`
  - `subtitleArgs(inputPath, outputs: [{ index, path }])` → `string[]`
  - `createProgressParser(onSeconds)` → `(chunk: string|Buffer) => void`
  - `subtitleSidecarName(videoFile, track, taken: Set<string>)` → `string` (same folder as `videoFile`, POSIX relative path)
  - `TEMP_SUFFIX = '.converting'`

- [ ] **Step 1: Write the failing tests**

Create `test/conversions.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProgressParser,
  ffmpegArgs,
  planConversion,
  subtitleArgs,
  subtitleSidecarName,
} from '../src/conversions.js';

const h264 = { index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' };
const aac = (index, extra = {}) => ({ index, codec_type: 'audio', codec_name: 'aac', channels: 2, ...extra });
const probeOf = (...streams) => ({ streams, format: { duration: '5400.5' } });

test('planConversion leaves browser-friendly mp4 files alone', () => {
  assert.equal(planConversion(probeOf(h264, aac(1)), 'Film.mp4'), null);
  assert.equal(planConversion(probeOf(h264, aac(1, { codec_name: 'mp3' })), 'a/Film.m4v'), null);
  assert.equal(planConversion(probeOf(h264, aac(1, { codec_name: 'opus' })), 'Film.mp4'), null);
  assert.equal(planConversion(probeOf(h264), 'Muet.mp4'), null);
});

test('planConversion remuxes other containers to mp4', () => {
  const plan = planConversion(probeOf(h264, aac(1)), 'dir/Film.2001.mkv');
  assert.equal(plan.video, 'copy');
  assert.equal(plan.outputFile, 'dir/Film.2001.mp4');
  assert.deepEqual(plan.audio, [{ index: 1, action: 'copy', bitrate: null, downmix: false, isDefault: true }]);
  assert.equal(plan.duration, 5400.5);
});

test('planConversion re-encodes video browsers cannot decode', () => {
  assert.equal(planConversion(probeOf({ ...h264, codec_name: 'hevc' }, aac(1)), 'Film.mp4').video, 'x264');
  assert.equal(planConversion(probeOf({ ...h264, pix_fmt: 'yuv420p10le' }, aac(1)), 'Film.mp4').video, 'x264');
  assert.equal(planConversion(probeOf({ ...h264, codec_name: 'mpeg4' }), 'Film.avi').video, 'x264');
  const hdr = planConversion(probeOf({ ...h264, codec_name: 'hevc', color_transfer: 'smpte2084' }), 'Film.mkv');
  assert.equal(hdr.hdr, true);
  assert.equal(planConversion(probeOf({ ...h264, codec_name: 'hevc' }), 'Film.mkv').hdr, false);
});

test('planConversion ignores cover images and needs a video track', () => {
  const cover = { index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } };
  const plan = planConversion(probeOf(cover, { ...h264, index: 1 }, aac(2, { codec_name: 'ac3' })), 'Film.mkv');
  assert.equal(plan.videoIndex, 1);
  assert.throws(() => planConversion(probeOf(aac(0)), 'Film.mkv'), /Aucune piste vidéo/);
});

test('planConversion keeps every audio track, re-encodes to AAC and makes French the default', () => {
  const plan = planConversion(
    probeOf(
      h264,
      aac(1, { codec_name: 'dts', channels: 8, tags: { language: 'eng' }, disposition: { default: 1 } }),
      aac(2, { codec_name: 'ac3', channels: 6, tags: { language: 'fre' } }),
      aac(3, { codec_name: 'aac', channels: 2, tags: { language: 'ita' } }),
      aac(4, { codec_name: 'flac', channels: 1 }),
    ),
    'Film.mkv',
  );
  assert.deepEqual(plan.audio, [
    { index: 1, action: 'aac', bitrate: '640k', downmix: true, isDefault: false },
    { index: 2, action: 'aac', bitrate: '640k', downmix: false, isDefault: true },
    { index: 3, action: 'copy', bitrate: null, downmix: false, isDefault: false },
    { index: 4, action: 'aac', bitrate: '256k', downmix: false, isDefault: false },
  ]);
});

test('planConversion falls back to the source default track, then the first one', () => {
  const eng = aac(1, { codec_name: 'ac3', tags: { language: 'eng' } });
  const ita = aac(2, { codec_name: 'ac3', tags: { language: 'ita' }, disposition: { default: 1 } });
  assert.deepEqual(planConversion(probeOf(h264, eng, ita), 'F.mkv').audio.map((a) => a.isDefault), [false, true]);
  assert.deepEqual(
    planConversion(probeOf(h264, eng, { ...ita, disposition: {} }), 'F.mkv').audio.map((a) => a.isDefault),
    [true, false],
  );
});

test('planConversion lists text subtitles to extract and drops bitmap ones', () => {
  const plan = planConversion(
    probeOf(
      h264,
      aac(1),
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'fre' }, disposition: { forced: 1 } },
      { index: 3, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' } },
      { index: 4, codec_type: 'subtitle', codec_name: 'ass' },
      { index: 5, codec_type: 'attachment', codec_name: 'ttf' },
    ),
    'Film.mkv',
  );
  assert.deepEqual(plan.subtitles, [
    { index: 2, lang: 'fre', forced: true },
    { index: 4, lang: null, forced: false },
  ]);
});

test('ffmpegArgs remuxes with stream copy and sets the default audio track', () => {
  const plan = planConversion(probeOf(h264, aac(1), aac(2, { codec_name: 'ac3', channels: 6, tags: { language: 'fra' } })), 'F.mkv');
  assert.deepEqual(ffmpegArgs(plan, '/m/F.mkv', '/m/.F.mp4.converting'), [
    '-hide_banner', '-v', 'error', '-nostdin', '-y', '-i', '/m/F.mkv',
    '-map', '0:0', '-map', '0:1', '-map', '0:2',
    '-c:v', 'copy',
    '-c:a:0', 'copy', '-disposition:a:0', '0',
    '-c:a:1', 'aac', '-b:a:1', '640k', '-disposition:a:1', 'default',
    '-map_metadata', '0', '-map_chapters', '0',
    '-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', '-nostats',
    '/m/.F.mp4.converting',
  ]);
});

test('ffmpegArgs re-encodes video with x264, downmixes and tone-maps HDR when zscale exists', () => {
  const plan = planConversion(
    probeOf({ ...h264, codec_name: 'hevc', color_transfer: 'smpte2084' }, aac(1, { codec_name: 'truehd', channels: 8 })),
    'F.mkv',
  );
  const args = ffmpegArgs(plan, 'in', 'out', { zscale: true });
  const video = args.slice(args.indexOf('-c:v'), args.indexOf('-c:a:0'));
  assert.deepEqual(video, [
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-vf', 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
  ]);
  assert.ok(args.join(' ').includes('-c:a:0 aac -b:a:0 640k -ac:a:0 6 -disposition:a:0 default'));
  assert.ok(!ffmpegArgs(plan, 'in', 'out', { zscale: false }).includes('-vf'));
});

test('subtitleArgs extracts every track to SRT in one pass', () => {
  assert.deepEqual(subtitleArgs('/m/F.mkv', [{ index: 2, path: '/m/a' }, { index: 4, path: '/m/b' }]), [
    '-hide_banner', '-v', 'error', '-nostdin', '-y', '-i', '/m/F.mkv',
    '-map', '0:2', '-c:s', 'srt', '-f', 'srt', '/m/a',
    '-map', '0:4', '-c:s', 'srt', '-f', 'srt', '/m/b',
  ]);
});

test('createProgressParser reads out_time_us across split chunks', () => {
  const seen = [];
  const parse = createProgressParser((s) => seen.push(s));
  parse('frame=10\nout_time_us=1500');
  parse('000\nout_time=00:00:01.500000\n');
  parse(Buffer.from('out_time_us=N/A\nout_time_us=3000000\nprogress=end\n'));
  assert.deepEqual(seen, [1.5, 3]);
});

test('subtitleSidecarName follows the naming read by the subtitle service', () => {
  const taken = new Set(['d/Film.fr.srt']);
  assert.equal(subtitleSidecarName('d/Film.mp4', { lang: 'eng', forced: false }, taken), 'd/Film.en.srt');
  assert.equal(subtitleSidecarName('d/Film.mp4', { lang: 'fre', forced: true }, taken), 'd/Film.fr.forced.srt');
  assert.equal(subtitleSidecarName('d/Film.mp4', { lang: 'fra', forced: false }, taken), 'd/Film.fr.2.srt');
  assert.equal(subtitleSidecarName('Film.mp4', { lang: null, forced: false }, new Set()), 'Film.srt');
  assert.equal(subtitleSidecarName('Film.mp4', { lang: 'xyz', forced: false }, new Set()), 'Film.xyz.srt');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/conversions.test.js`
Expected: FAIL — `Cannot find module '.../src/conversions.js'`.

- [ ] **Step 3: Write the helpers**

Create `src/conversions.js`:

```js
// Converts movies browsers can't play (container or codecs) to MP4 H.264/AAC, replacing the
// original file. Text subtitles are extracted next to the new file first, since MP4 can't keep them.
import path from 'node:path';
import { describeSubtitle } from './subtitles.js';

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/conversions.test.js`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/conversions.js test/conversions.test.js
git commit -m "Add conversion planning helpers (ffprobe → plan → ffmpeg args)"
```

---

### Task 2: Library lock and movie rename in `scanner.js`

**Files:**
- Modify: `src/scanner.js` (add after `writeMoviesInfos`, ~line 52)
- Test: `test/conversions.test.js`

**Interfaces:**
- Produces:
  - `runExclusive(fn)` → `Promise<ReturnType<fn>>`: runs `fn` once every previously queued call settled; a rejection doesn't block later calls.
  - `renameMovieEntry(config, oldFile, newFile)` → `Promise<boolean>`: points the `movies.json` entry for `oldFile` to `newFile` (keeps `id` and all other fields, refreshes `size` from disk); `false` if no entry.

- [ ] **Step 1: Write the failing tests**

Append to `test/conversions.test.js` (merge the imports at the top of the file):

```js
import { before, after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readMoviesInfos, renameMovieEntry, runExclusive } from '../src/scanner.js';

let dir;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cineflix-conv-'));
});
after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A fresh library folder + infos file for one test. */
async function makeLibrary(name, movies = []) {
  const config = { moviesPath: path.join(dir, name, 'movies'), moviesInfosPath: path.join(dir, name, 'movies.json') };
  await fs.mkdir(config.moviesPath, { recursive: true });
  await fs.writeFile(config.moviesInfosPath, JSON.stringify({ updatedAt: null, movies }));
  return config;
}

test('runExclusive runs callbacks one after the other, even after a failure', async () => {
  const order = [];
  const slow = runExclusive(async () => {
    await new Promise((r) => setTimeout(r, 30));
    order.push('slow');
  });
  const failing = runExclusive(async () => {
    order.push('failing');
    throw new Error('boom');
  });
  const last = runExclusive(() => order.push('last'));
  await slow;
  await assert.rejects(failing, /boom/);
  await last;
  assert.deepEqual(order, ['slow', 'failing', 'last']);
});

test('renameMovieEntry keeps the id and metadata of the movie', async () => {
  const config = await makeLibrary('rename', [
    { id: 'abc123abc123', file: 'd/Film.mkv', size: 10, title: 'Film', matched: true },
    { id: 'other0other0', file: 'Autre.mp4', size: 5, title: 'Autre', matched: true },
  ]);
  await fs.mkdir(path.join(config.moviesPath, 'd'));
  await fs.writeFile(path.join(config.moviesPath, 'd/Film.mp4'), 'x'.repeat(42));

  assert.equal(await renameMovieEntry(config, 'd/Film.mkv', 'd/Film.mp4'), true);
  const { movies } = await readMoviesInfos(config.moviesInfosPath);
  assert.deepEqual(movies[0], { id: 'abc123abc123', file: 'd/Film.mp4', size: 42, title: 'Film', matched: true });
  assert.equal(movies[1].file, 'Autre.mp4');
  assert.equal(await renameMovieEntry(config, 'nope.mkv', 'nope.mp4'), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/conversions.test.js`
Expected: FAIL — `does not provide an export named 'renameMovieEntry'`.

- [ ] **Step 3: Implement**

In `src/scanner.js`, after `writeMoviesInfos`:

```js
let libraryLock = Promise.resolve();

/**
 * Serialises changes to MOVIES_PATH / MOVIES_INFOS_PATH within the server (scans, converted files
 * replacing originals), so a scan never sees a file swap half done.
 */
export function runExclusive(fn) {
  const result = libraryLock.then(fn);
  libraryLock = result.catch(() => {});
  return result;
}

/** Point the entry of `oldFile` to `newFile`, keeping its id (watch progress) and TMDB data. */
export async function renameMovieEntry(config, oldFile, newFile) {
  const infos = await readMoviesInfos(config.moviesInfosPath);
  const movie = infos.movies.find((m) => m.file === oldFile);
  if (!movie) return false;
  movie.file = newFile;
  movie.size = (await fs.stat(path.join(config.moviesPath, newFile))).size;
  await writeMoviesInfos(config.moviesInfosPath, infos);
  return true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/conversions.test.js && npm test`
Expected: PASS, existing suite still green.

- [ ] **Step 5: Commit**

```bash
git add src/scanner.js test/conversions.test.js
git commit -m "Add library lock and renameMovieEntry to the scanner"
```

---

### Task 3: Watcher runs under the lock and reports added movies

**Files:**
- Modify: `src/watcher.js:16-46` (`watchMovies` / `check`)
- Test: `test/conversions.test.js`

**Interfaces:**
- Consumes: `runExclusive`, `readMoviesInfos` from `src/scanner.js`.
- Produces: `watchMovies(config, { logger, pollMs, scan, onScanned })` — `onScanned(addedMovies: Movie[])` is called (not awaited by the lock) after each scan that added movies; `addedMovies` are the `movies.json` entries whose `file` wasn't there before the scan.

- [ ] **Step 1: Write the failing test**

Append to `test/conversions.test.js` (add `import { watchMovies } from '../src/watcher.js';` at the top):

```js
test('watcher scans under the library lock and reports added movies', async () => {
  const config = await makeLibrary('watch', [{ id: 'old000old000', file: 'Ancien.mp4' }]);
  await fs.writeFile(path.join(config.moviesPath, 'Ancien.mp4'), 'x');
  await fs.writeFile(path.join(config.moviesPath, 'Nouveau.mkv'), 'x');

  const events = [];
  const fakeScan = async () => {
    events.push('scan:start');
    await new Promise((r) => setTimeout(r, 30));
    await fs.writeFile(
      config.moviesInfosPath,
      JSON.stringify({ movies: [{ id: 'old000old000', file: 'Ancien.mp4' }, { id: 'new000new000', file: 'Nouveau.mkv' }] }),
    );
    events.push('scan:end');
    return {};
  };
  const added = [];
  const quiet = { info() {}, warn() {}, error() {} };
  const watcher = watchMovies(config, { logger: quiet, pollMs: 60_000, scan: fakeScan, onScanned: (m) => added.push(...m) });
  try {
    const checking = watcher.check();
    await new Promise((r) => setTimeout(r, 5));
    await runExclusive(() => events.push('exclusive'));
    await checking;
    assert.deepEqual(events, ['scan:start', 'scan:end', 'exclusive']);
    assert.deepEqual(added.map((m) => m.id), ['new000new000']);
  } finally {
    watcher.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern="library lock" test/conversions.test.js`
Expected: FAIL — events show `exclusive` before `scan:end`, or `added` is empty.

- [ ] **Step 3: Implement**

In `src/watcher.js`, change the import and `watchMovies`:

```js
import { listVideoFiles, readMoviesInfos, runExclusive, scanMovies } from './scanner.js';
```

```js
export function watchMovies(config, { logger = console, pollMs = DEFAULT_POLL_MS, scan = scanMovies, onScanned } = {}) {
```

Replace the body of the `do { … } while (rerun)` loop with:

```js
      do {
        rerun = false;
        try {
          // Under the library lock: a conversion never swaps a file while we list or scan.
          const added = await runExclusive(async () => {
            if (!(await needsScan(config))) return [];
            const before = new Set((await readMoviesInfos(config.moviesInfosPath)).movies.map((m) => m.file));
            logger.info('Movie library changed, scanning TMDB…');
            const stats = await scan(config, { logger });
            logger.info(stats, 'Movie scan finished');
            return (await readMoviesInfos(config.moviesInfosPath)).movies.filter((m) => !before.has(m.file));
          });
          if (added.length) onScanned?.(added);
        } catch (err) {
          logger.error(err, 'Movie scan failed');
        }
      } while (rerun);
```

Update the header comment of the file: add a line "After a scan, `onScanned` receives the movies it added (they may need a conversion)."

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add src/watcher.js test/conversions.test.js
git commit -m "Run watcher scans under the library lock and report added movies"
```

---

### Task 4: Conversion manager

**Files:**
- Modify: `src/conversions.js` (append)
- Test: `test/conversions.test.js`

**Interfaces:**
- Consumes: Task 1 helpers; `runExclusive`, `renameMovieEntry` from `src/scanner.js`.
- Produces:
  - `createConversionTracking(filePath, { logger })` → `{ has(file, stat): Promise<boolean>, record(file, stat, { converted, source? }): Promise<void> }` (`convert.json`)
  - `createConversionManager(config, { logger = console, stableMs = 5_000, probe = ffprobe, trackingPath = <data dir>/convert.json } = {})` returning:
  - `enqueue(movie: { id, file })` → `Promise<void>` (resolves once the file is stable and probed/queued, not once converted; immediately for files tracked in `convert.json`)
  - `status(id)` → `{ status: 'queued'|'converting'|'failed', percent: number, error: string|null } | null`
  - `list()` → `{ [id]: status(id) }`
  - `isBusy(id)` → `boolean` (`queued` or `converting`)
  - `idle()` → `Promise<void>` resolving when the queue is empty and nothing runs (tests)
  - `cleanup()` → `Promise<number>` temp files removed
  - `close()` → `Promise<void>`

- [ ] **Step 1: Write the failing integration tests**

Append to `test/conversions.test.js` (add to imports: `import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { createConversionManager } from '../src/conversions.js';`):

```js
const run = promisify(execFile);
const hasFfmpeg = await run('ffmpeg', ['-version']).then(() => true, () => false);
const quiet = { info() {}, warn() {}, error() {} };

/** MPEG-2 video + English AC3 5.1 (default) + French AC3 5.1 + French SRT, in an mkv. */
async function makeIncompatibleMkv(file, { seconds = 2 } = {}) {
  const srt = `${file}.src.srt`;
  await fs.writeFile(srt, '1\n00:00:00,500 --> 00:00:01,500\nBonjour\n');
  await run('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x240:rate=25`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=880:duration=${seconds}`,
    '-i', srt,
    '-map', '0', '-map', '1', '-map', '2', '-map', '3',
    '-c:v', 'mpeg2video', '-c:a', 'ac3', '-ac', '6', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fre', '-metadata:s:s:0', 'language=fre',
    '-disposition:a:0', 'default', '-disposition:a:1', '0',
    file,
  ]);
  await fs.rm(srt);
}

async function makeCompatibleMp4(file) {
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=25', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
}

async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  return JSON.parse(stdout);
}

test('converts an incompatible mkv into an mp4 that replaces it', { skip: !hasFfmpeg }, async () => {
  const movie = { id: 'conv00conv00', file: 'd/Film.mkv', title: 'Film', matched: true };
  const config = await makeLibrary('convert', [movie]);
  await fs.mkdir(path.join(config.moviesPath, 'd'));
  const source = path.join(config.moviesPath, 'd/Film.mkv');
  await makeIncompatibleMkv(source);
  const oldTime = new Date('2020-01-02T03:04:05Z');
  await fs.utimes(source, oldTime, oldTime);

  const conversions = createConversionManager(config, { logger: quiet, stableMs: 0 });
  await conversions.enqueue(movie);
  assert.equal(conversions.isBusy(movie.id), true);
  assert.ok(['queued', 'converting'].includes(conversions.status(movie.id).status));
  await conversions.idle();

  assert.equal(conversions.status(movie.id), null);
  assert.deepEqual(conversions.list(), {});
  await assert.rejects(fs.stat(source), 'the mkv is gone');
  const output = path.join(config.moviesPath, 'd/Film.mp4');
  const { streams, format } = await probe(output);
  assert.deepEqual(streams.map((s) => s.codec_name), ['h264', 'aac', 'aac']);
  assert.deepEqual(streams.filter((s) => s.codec_type === 'audio').map((s) => s.disposition.default), [0, 1]);
  assert.ok(Math.abs(Number(format.duration) - 2) < 0.5);
  assert.equal((await fs.stat(output)).mtime.toISOString(), oldTime.toISOString(), 'keeps its date');
  assert.match(await fs.readFile(path.join(config.moviesPath, 'd/Film.fr.srt'), 'utf8'), /Bonjour/);
  assert.deepEqual((await fs.readdir(path.join(config.moviesPath, 'd'))).sort(), ['Film.fr.srt', 'Film.mp4'], 'no temp file left');

  const { movies } = await readMoviesInfos(config.moviesInfosPath);
  assert.deepEqual(movies.map((m) => [m.id, m.file, m.title]), [['conv00conv00', 'd/Film.mp4', 'Film']]);
});

test('leaves compatible movies alone without ever showing a status', { skip: !hasFfmpeg }, async () => {
  const movie = { id: 'okok00okok00', file: 'Ok.mp4' };
  const config = await makeLibrary('compatible', [movie]);
  const file = path.join(config.moviesPath, 'Ok.mp4');
  await makeCompatibleMp4(file);
  const before = await fs.stat(file);
  const conversions = createConversionManager(config, { logger: quiet, stableMs: 0 });
  await conversions.enqueue(movie);
  assert.equal(conversions.status(movie.id), null);
  await conversions.idle();
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
});

test('enqueue is idempotent', { skip: !hasFfmpeg }, async () => {
  const movie = { id: 'twice0twice0', file: 'Twice.mkv' };
  const config = await makeLibrary('twice', [movie]);
  await makeIncompatibleMkv(path.join(config.moviesPath, 'Twice.mkv'));
  const conversions = createConversionManager(config, { logger: quiet, stableMs: 0 });
  await Promise.all([conversions.enqueue(movie), conversions.enqueue(movie), conversions.enqueue({ ...movie })]);
  await conversions.idle();
  // Converted twice would leave "Twice (1).mp4" or "Twice.fr.2.srt", or fail on the missing mkv.
  assert.deepEqual((await fs.readdir(config.moviesPath)).sort(), ['Twice.fr.srt', 'Twice.mp4']);
  assert.equal(conversions.status(movie.id), null);
});

test('never overwrites another file when the mp4 name is taken', { skip: !hasFfmpeg }, async () => {
  const movie = { id: 'taken0taken0', file: 'Film.mkv' };
  const config = await makeLibrary('taken', [movie, { id: 'other0other0', file: 'Film.mp4' }]);
  await makeIncompatibleMkv(path.join(config.moviesPath, 'Film.mkv'));
  await fs.writeFile(path.join(config.moviesPath, 'Film.mp4'), 'another movie');
  const conversions = createConversionManager(config, { logger: quiet, stableMs: 0 });
  await conversions.enqueue(movie);
  await conversions.idle();
  assert.equal(await fs.readFile(path.join(config.moviesPath, 'Film.mp4'), 'utf8'), 'another movie');
  const { movies } = await readMoviesInfos(config.moviesInfosPath);
  assert.equal(movies.find((m) => m.id === movie.id).file, 'Film (1).mp4');
  assert.ok(await fs.stat(path.join(config.moviesPath, 'Film (1).fr.srt')));
});

test('a broken file fails, keeps the original and lets the queue move on', { skip: !hasFfmpeg }, async () => {
  const broken = { id: 'broken000000', file: 'Broken.mkv' };
  const good = { id: 'good00good00', file: 'Good.mkv' };
  const config = await makeLibrary('broken', [broken, good]);
  await makeIncompatibleMkv(path.join(config.moviesPath, 'Good.mkv'));
  // Valid header (probe succeeds) but truncated data (conversion or verification fails).
  const full = await fs.readFile(path.join(config.moviesPath, 'Good.mkv'));
  await fs.writeFile(path.join(config.moviesPath, 'Broken.mkv'), full.subarray(0, Math.floor(full.length / 3)));
  await fs.writeFile(path.join(config.moviesPath, 'Garbage.mkv'), 'not a video');
  const garbage = { id: 'garbage00000', file: 'Garbage.mkv' };

  const conversions = createConversionManager(config, { logger: quiet, stableMs: 0 });
  await conversions.enqueue(garbage);
  await conversions.enqueue(broken);
  await conversions.enqueue(good);
  await conversions.idle();

  assert.equal(conversions.status(garbage.id).status, 'failed');
  assert.equal(conversions.status(broken.id).status, 'failed');
  assert.ok(conversions.status(broken.id).error);
  assert.equal(conversions.isBusy(broken.id), false);
  assert.ok(await fs.stat(path.join(config.moviesPath, 'Broken.mkv')), 'original kept');
  assert.equal(conversions.status(good.id), null, 'next movie still converted');
  const names = await fs.readdir(config.moviesPath);
  assert.ok(!names.some((n) => n.endsWith('.converting')), 'temp files removed');

  // A failed movie is only retried by a new manager (next startup).
  await conversions.enqueue(broken);
  assert.equal(conversions.status(broken.id).status, 'failed');
});

test('converts a file only once its size is stable', { skip: !hasFfmpeg }, async () => {
  const movie = { id: 'stable000000', file: 'Copie.mkv' };
  const config = await makeLibrary('stable', [movie]);
  const complete = path.join(dir, 'stable', 'complete.mkv'); // outside the library
  await makeIncompatibleMkv(complete, { seconds: 4 });
  const bytes = await fs.readFile(complete);
  const target = path.join(config.moviesPath, 'Copie.mkv');
  // Half copied when the manager first looks at it, complete 150 ms later.
  await fs.writeFile(target, bytes.subarray(0, bytes.length >> 1));
  const conversions = createConversionManager(config, { logger: quiet, stableMs: 300 });
  const enqueued = conversions.enqueue(movie);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(conversions.status(movie.id), null, 'not probed yet');
  await fs.writeFile(target, bytes);
  await enqueued;
  await conversions.idle();
  const { format } = await probe(path.join(config.moviesPath, 'Copie.mp4'));
  assert.ok(Math.abs(Number(format.duration) - 4) < 0.5, 'the whole file was converted');
});

test('convert.json records checked files so they are never probed twice', { skip: !hasFfmpeg }, async () => {
  const converted = { id: 'track0track0', file: 'Vieux.mkv' };
  const compatible = { id: 'track1track1', file: 'Ok.mp4' };
  const config = await makeLibrary('tracking', [converted, compatible]);
  await makeIncompatibleMkv(path.join(config.moviesPath, 'Vieux.mkv'));
  await makeCompatibleMp4(path.join(config.moviesPath, 'Ok.mp4'));
  const first = createConversionManager(config, { logger: quiet, stableMs: 0 });
  await first.enqueue(converted);
  await first.enqueue(compatible);
  await first.idle();

  const { files } = JSON.parse(await fs.readFile(path.join(dir, 'tracking', 'convert.json'), 'utf8'));
  const stat = await fs.stat(path.join(config.moviesPath, 'Vieux.mp4'));
  const { at, ...entry } = files['Vieux.mp4'];
  assert.ok(at);
  assert.deepEqual(entry, { size: stat.size, mtimeMs: stat.mtimeMs, converted: true, source: 'Vieux.mkv' });
  assert.equal(files['Ok.mp4'].converted, false);
  assert.equal(files['Vieux.mkv'], undefined);

  // A new manager (next startup) trusts convert.json…
  const probed = [];
  const spy = async (file) => {
    probed.push(path.basename(file));
    throw new Error('unexpected probe');
  };
  const second = createConversionManager(config, { logger: quiet, stableMs: 0, probe: spy });
  await second.enqueue({ ...converted, file: 'Vieux.mp4' });
  await second.enqueue(compatible);
  assert.deepEqual(probed, []);
  assert.deepEqual(second.list(), {});

  // …until the file changes.
  await fs.appendFile(path.join(config.moviesPath, 'Ok.mp4'), 'x');
  await second.enqueue(compatible);
  assert.deepEqual(probed, ['Ok.mp4']);
});

test('close() kills ffmpeg and keeps the original; cleanup() removes leftovers', { skip: !hasFfmpeg }, async () => {
  const movie = { id: 'close0close0', file: 'Long.mkv' };
  const config = await makeLibrary('close', [movie]);
  await makeIncompatibleMkv(path.join(config.moviesPath, 'Long.mkv'), { seconds: 120 });
  const conversions = createConversionManager(config, { logger: quiet, stableMs: 0 });
  await conversions.enqueue(movie);
  for (let i = 0; i < 500 && conversions.status(movie.id)?.status !== 'converting'; i++) await new Promise((r) => setTimeout(r, 10));
  await conversions.close();
  assert.deepEqual(await fs.readdir(config.moviesPath), ['Long.mkv']);

  await fs.mkdir(path.join(config.moviesPath, 'sub'));
  await fs.writeFile(path.join(config.moviesPath, 'sub/.Old.mp4.converting'), 'x');
  await fs.writeFile(path.join(config.moviesPath, '.Old.fr.srt.converting'), 'x');
  const fresh = createConversionManager(config, { logger: quiet, stableMs: 0 });
  assert.equal(await fresh.cleanup(), 2);
  assert.deepEqual(await fs.readdir(path.join(config.moviesPath, 'sub')), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/conversions.test.js`
Expected: FAIL — `does not provide an export named 'createConversionManager'`.

- [ ] **Step 3: Implement the manager**

Add imports at the top of `src/conversions.js`:

```js
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { renameMovieEntry, runExclusive } from './scanner.js';

const run = promisify(execFile);
```

Append:

```js
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
   * Resolves with the file's stat once its size hasn't changed for `stableMs` (still being copied
   * or downloaded otherwise). A file not modified for that long is stable right away.
   */
  async function waitUntilStable(full) {
    let before = await fs.stat(full);
    for (;;) {
      if (Date.now() - before.mtimeMs >= stableMs) return before;
      await sleep(stableMs, null, { signal: abort.signal });
      const after = await fs.stat(full);
      if (after.size === before.size) return after;
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
        await convert(state, job);
        states.delete(state.id);
      } catch (err) {
        if (abort.signal.aborted) {
          states.delete(state.id);
        } else {
          Object.assign(state, { status: 'failed', percent: 0, error: err.message });
          logger.warn(`Conversion failed for "${state.file}": ${err.message}`);
        }
      } finally {
        await Promise.all(job.temps.map((t) => fs.rm(t, { force: true })));
      }
    }
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

    const outputFile = await freeName(plan.outputFile, state.file);
    const outputPath = path.join(moviesPath, outputFile);

    // 1. Text subtitles → sidecar .srt files (MP4 can't keep them).
    const dir = path.posix.dirname(outputFile);
    const taken = new Set(
      (await fs.readdir(path.dirname(outputPath))).map((name) => (dir === '.' ? name : `${dir}/${name}`)),
    );
    const sidecars = plan.subtitles.map((track) => {
      const name = subtitleSidecarName(outputFile, track, taken);
      taken.add(name);
      const final = path.join(moviesPath, name);
      return { index: track.index, final, path: tempPathFor(final) };
    });
    job.temps.push(...sidecars.map((s) => s.path));
    if (sidecars.length) await ffmpeg(subtitleArgs(sourcePath, sidecars), { signal: abort.signal });

    // 2. Audio/video into a hidden temp file.
    const tempPath = tempPathFor(outputPath);
    job.temps.push(tempPath);
    const onProgress = createProgressParser((seconds) => {
      if (plan.duration) state.percent = Math.min(99, Math.floor((seconds / plan.duration) * 100));
    });
    await ffmpeg(ffmpegArgs(plan, sourcePath, tempPath, { zscale }), { signal: abort.signal, onStdout: onProgress });

    // 3. Check the result before throwing the original away.
    await verify(tempPath, plan);
    await fs.utimes(tempPath, source.atime, source.mtime); // keeps its place in "Ajoutés récemment"

    // 4. Swap files and update movies.json together, so a scan never sees half of it.
    await runExclusive(async () => {
      for (const s of sidecars) await fs.rename(s.path, s.final);
      await fs.rename(tempPath, outputPath);
      if (outputFile !== state.file) {
        await fs.rm(sourcePath, { force: true });
        await renameMovieEntry(config, state.file, outputFile);
      }
    });
    plans.delete(state.file);

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
        await fs.rm(file, { force: true });
        removed++;
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
```

Note on `close()`: aborting the signal kills ffmpeg (`spawn` `signal` option, `SIGKILL`), the `ffmpeg()` promise rejects, `work()`'s `finally` deletes the temp files, and the movie's state is dropped.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/conversions.test.js`
Expected: PASS (the ffmpeg tests take a few seconds; they are skipped when ffmpeg isn't installed).

If `a broken file fails…` doesn't fail on the truncated `Broken.mkv` (ffmpeg may decode the truncated part without error), the duration check in `verify` must catch it: the probe of the truncated mkv still reports the full duration from the header. If the header doesn't carry the duration either, truncate at 1/3 of a 10 s file instead and keep the assertion — don't weaken it.

- [ ] **Step 5: Commit**

```bash
git add src/conversions.js test/conversions.test.js
git commit -m "Add the conversion manager (queue, ffmpeg, verification, file swap)"
```

---

### Task 5: API — conversion status, polling endpoint, 409 on stream

**Files:**
- Modify: `src/app.js:64-73` (`buildApp` setup), `src/app.js:115-119` (`GET /api/movies`), `src/app.js:231-234` (stream route); add `GET /api/conversions`
- Test: `test/backend.test.js`

**Interfaces:**
- Consumes: `createConversionManager` (Task 4).
- Produces: `buildApp(config, { logger = true, conversions })` — when `conversions` isn't given, creates `createConversionManager(config, { logger: app.log })`; exposed as `app.conversions`; closed in `onClose`. `GET /api/movies` adds `conversion: { status, percent, error }` to movies with a status. `GET /api/conversions` → `{ [id]: { status, percent, error } }`. Stream → 409 `{ error: 'Conversion en cours' }` when busy.

- [ ] **Step 1: Write the failing test**

Append to `test/backend.test.js`:

```js
test('HTTP API: conversion status and blocked streaming', async () => {
  const statuses = new Map();
  const fakeConversions = {
    status: (id) => statuses.get(id) ?? null,
    list: () => Object.fromEntries(statuses),
    isBusy: (id) => ['queued', 'converting'].includes(statuses.get(id)?.status),
    close: async () => {},
  };
  const app = buildApp(config, { logger: false, conversions: fakeConversions });
  try {
    assert.equal((await app.inject('/api/conversions')).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'lorys', password: 'pw' } });
    const cookies = { session: login.cookies.find((c) => c.name === 'session').value };
    const { movies } = (await app.inject({ url: '/api/movies', cookies })).json();
    const amelie = movies.find((m) => m.file === 'Amelie.2001.mp4');
    assert.equal(amelie.conversion, undefined);

    statuses.set(amelie.id, { status: 'converting', percent: 42, error: null });
    const listed = (await app.inject({ url: '/api/movies', cookies })).json().movies.find((m) => m.id === amelie.id);
    assert.deepEqual(listed.conversion, { status: 'converting', percent: 42, error: null });
    assert.deepEqual((await app.inject({ url: '/api/conversions', cookies })).json(), {
      [amelie.id]: { status: 'converting', percent: 42, error: null },
    });
    const blocked = await app.inject({ url: `/api/movies/${amelie.id}/stream`, cookies });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().error, 'Conversion en cours');

    // A failed conversion leaves the original playable.
    statuses.set(amelie.id, { status: 'failed', percent: 0, error: 'boom' });
    assert.equal((await app.inject({ url: `/api/movies/${amelie.id}/stream`, cookies })).statusCode, 200);
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern="conversion status" test/backend.test.js`
Expected: FAIL — `/api/conversions` returns 404 (not 401).

- [ ] **Step 3: Implement**

In `src/app.js`, add the import:

```js
import { createConversionManager } from './conversions.js';
```

Change the signature and setup:

```js
export function buildApp(config, { logger = true, conversions } = {}) {
  const app = Fastify({ logger });
  …
  const downloads = createDownloadManager(config.moviesPath, { logger: app.log });
  conversions ??= createConversionManager(config, { logger: app.log });
  app.decorate('conversions', conversions);
  …
  app.addHook('onClose', () => downloads.close());
  app.addHook('onClose', () => conversions.close());
```

Replace `GET /api/movies`:

```js
  app.get('/api/movies', { preHandler: requireUser }, async () => {
    const { updatedAt, movies } = await getInfos();
    // `parsed` and `size` are scanner internals; the frontend doesn't need them.
    return {
      updatedAt,
      movies: movies.map(({ parsed, size, ...movie }) => {
        const conversion = conversions.status(movie.id);
        return conversion ? { ...movie, conversion } : movie;
      }),
    };
  });

  app.get('/api/conversions', { preHandler: requireUser }, async () => conversions.list());
```

In the stream route, right after the `if (!movie) return …404` line:

```js
    // The file is about to be replaced: don't serve it.
    if (conversions.isBusy(movie.id)) return reply.code(409).send({ error: 'Conversion en cours' });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add src/app.js test/backend.test.js
git commit -m "Expose conversion status in the API and refuse streaming while converting"
```

---

### Task 6: Startup wiring, config, Docker and env docs

**Files:**
- Modify: `src/config.js:17`, `src/index.js`, `.env.example`, `Dockerfile:3-4,14-15`

**Interfaces:**
- Consumes: `app.conversions` (Task 5), `watchMovies(…, { onScanned })` (Task 3), `readMoviesInfos`.
- Produces: `config.convertOnStart: boolean`.

- [ ] **Step 1: Write the failing test**

Append to `test/backend.test.js` (add `import { loadConfig } from '../src/config.js';` at the top):

```js
test('loadConfig reads CONVERT_ON_START (default true)', () => {
  const env = { MOVIES_PATH: '/m', MOVIES_INFOS_PATH: '/i.json', ACCOUNTS_PATH: '/a', ACCOUNTS_SECRET: 's' };
  assert.equal(loadConfig(env).convertOnStart, true);
  assert.equal(loadConfig({ ...env, CONVERT_ON_START: 'false' }).convertOnStart, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern="CONVERT_ON_START" test/backend.test.js`
Expected: FAIL — `undefined !== true`.

- [ ] **Step 3: Implement**

`src/config.js`, after `scanOnStart`:

```js
    convertOnStart: env.CONVERT_ON_START !== 'false',
```

`src/index.js`, full new content:

```js
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { readMoviesInfos } from './scanner.js';
import { watchMovies } from './watcher.js';

const config = loadConfig();
const app = buildApp(config);
const { conversions } = app;

await app.listen({ host: config.host, port: config.port });
await conversions.cleanup();

// One at a time: each enqueue runs ffprobe on the file.
async function enqueueAll(movies) {
  for (const movie of movies) await conversions.enqueue(movie);
}

const watcher = watchMovies(config, { logger: app.log, onScanned: enqueueAll });
const scanned = config.scanOnStart ? watcher.check() : Promise.resolve();
if (config.convertOnStart) {
  scanned.then(async () => enqueueAll((await readMoviesInfos(config.moviesInfosPath)).movies)).catch((err) => app.log.error(err, 'Cannot queue conversions'));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    watcher.close();
    await app.close(); // also stops a running conversion
    process.exit(0);
  });
}
```

`.env.example`, in the Optional block after `# SCAN_ON_START=true`:

```sh
# Convert movies browsers can't play (needs ffmpeg) when the server starts; new movies are always converted
# CONVERT_ON_START=true
```

`Dockerfile`, replace the ffmpeg comment and the volume comment:

```dockerfile
# ffmpeg reads the subtitle tracks embedded in mkv/mp4 files and converts movies browsers can't play.
RUN apk add --no-cache ffmpeg
```

```dockerfile
# /movies: the video library (mounted read-write: downloads and conversions write into it)
# /data: movies.json (TMDB cache), accounts.enc (accounts + watch progress), subtitles/ (extracted tracks),
#        convert.json (files already converted or found compatible)
```

(replacing the existing two comment lines above `RUN mkdir -p /movies /data`)

- [ ] **Step 4: Run tests and a smoke start**

Run: `npm test`
Expected: PASS.

Smoke test (scratch library, no TMDB key needed — unmatched movies still appear):

```bash
S=$(mktemp -d) && mkdir -p $S/movies && \
ffmpeg -v error -f lavfi -i testsrc=duration=3:size=320x240:rate=25 -f lavfi -i sine=duration=3 -c:v mpeg2video -c:a ac3 "$S/movies/Test.2020.mkv" && \
touch -t 202001010000 "$S/movies/Test.2020.mkv" && \
(MOVIES_PATH=$S/movies MOVIES_INFOS_PATH=$S/movies.json ACCOUNTS_PATH=$S/a.enc ACCOUNTS_SECRET=x PORT=3999 node src/index.js & PID=$!; sleep 20; kill $PID); ls $S/movies
```

(`touch` makes the file look old, so it's stable right away instead of after the 5 s check.)
Expected: logs show `Converting "Test.2020.mkv"` then `Converted "Test.2020.mkv" → "Test.2020.mp4"`, and `ls` lists `Test.2020.mp4` only.

- [ ] **Step 5: Commit**

```bash
git add src/config.js src/index.js .env.example Dockerfile test/backend.test.js
git commit -m "Convert the library at startup and new movies after each scan"
```

---

### Task 7: Frontend — status on cards, modal, hero; polling

**Files:**
- Modify: `public/index.html:57-63` (modal actions), `public/index.html:187-192` (card template)
- Modify: `public/js/app.js` (catalogue, hero, modal, `playMovie`, new conversions section)
- Modify: `public/css/style.css` (after `.card__progress`, ~line 674)

**Interfaces:**
- Consumes: `movie.conversion` from `GET /api/movies`, `GET /api/conversions` (Task 5); 409 from the stream route.

No automated frontend tests exist in this project; verify manually (Step 5).

- [ ] **Step 1: Markup**

`public/index.html`, card template — add the overlay after the progress span:

```html
        <span class="card__conversion" hidden>
          <span class="card__conversion-text"></span>
          <span class="progress"><span></span></span>
        </span>
```

Modal — after the `modal__progress` div (inside `modal__hero-content`):

```html
            <p class="modal__conversion" id="modal-conversion" hidden></p>
```

- [ ] **Step 2: Styles**

`public/css/style.css`, after `.card__progress`:

```css
/* ---------- Conversion ---------- */

.card__conversion {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.6rem;
  padding: 0.8rem;
  background: rgba(0, 0, 0, 0.72);
  color: var(--fg);
  font-size: 0.85rem;
  font-weight: 600;
  text-align: center;
}
.card__conversion .progress { width: 100%; border-radius: 2px; }
.card--failed .card__conversion { justify-content: flex-end; background: linear-gradient(transparent 50%, rgba(0, 0, 0, 0.85)); color: #e87c03; }
.card--failed .card__conversion .progress { display: none; }
.modal__conversion { margin: 1rem 0 0; font-size: 0.95rem; color: var(--fg); }
.modal__conversion--failed { color: #e87c03; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
```

(`.btn:disabled` may already exist — check with `grep -n ':disabled' public/css/style.css` and skip if so.)

- [ ] **Step 3: Logic in `public/js/app.js`**

Add helpers after `progressPercent` (Catalogue section):

```js
const isConverting = (movie) => ['queued', 'converting'].includes(movie.conversion?.status);

function conversionLabel(conversion) {
  if (conversion.status === 'queued') return 'En attente de conversion';
  if (conversion.status === 'converting') return `Conversion en cours (${conversion.percent} %)`;
  return 'Échec de la conversion';
}

function renderCardConversion(card, movie) {
  const overlay = card.querySelector('.card__conversion');
  const { conversion } = movie;
  overlay.hidden = !conversion;
  card.classList.toggle('card--failed', conversion?.status === 'failed');
  if (!conversion) return;
  overlay.querySelector('.card__conversion-text').textContent = conversionLabel(conversion);
  overlay.querySelector('.progress > span').style.width = `${conversion.percent}%`;
  card.title = `${movie.title} — ${conversionLabel(conversion)}`;
}
```

In `createCard`, before `card.addEventListener('click', …)`:

```js
  card.dataset.id = movie.id;
  renderCardConversion(card, movie);
```

In `renderHero`, exclude movies being converted:

```js
  const candidates = movies.filter((m) => m.backdropPath && m.overview && !isConverting(m));
```

In `openModal`, after the `if (entry) { … }` block:

```js
  renderModalConversion();
```

and add after `openModal`:

```js
function renderModalConversion() {
  const movie = modalMovie;
  const busy = isConverting(movie);
  const label = $('modal-conversion');
  $('modal-play').disabled = busy;
  $('modal-restart').disabled = busy;
  label.hidden = !movie.conversion;
  label.classList.toggle('modal__conversion--failed', movie.conversion?.status === 'failed');
  if (movie.conversion) {
    label.textContent = movie.conversion.status === 'failed' && movie.conversion.error
      ? `${conversionLabel(movie.conversion)} : ${movie.conversion.error}`
      : conversionLabel(movie.conversion);
  }
}
```

In `playMovie`, first line:

```js
  if (isConverting(movie)) return;
```

In `showBrowse`, after `renderHome();`:

```js
  watchConversions();
```

Add a section before `// ---------- Downloads ----------`:

```js
// ---------- Conversions ----------

const CONVERSIONS_POLL_MS = 3000;
let conversionsTimer = null;

/** Polls conversion progress while some movie is waiting or converting. */
function watchConversions() {
  clearTimeout(conversionsTimer);
  if (movies.some(isConverting)) conversionsTimer = setTimeout(refreshConversions, CONVERSIONS_POLL_MS);
}

async function refreshConversions() {
  let statuses;
  try {
    statuses = await api('/api/conversions');
  } catch {
    return watchConversions();
  }
  let finished = false;
  for (const movie of movies) {
    const next = statuses[movie.id];
    if (isConverting(movie) && !next) finished = true;
    if (next) movie.conversion = next;
    else delete movie.conversion;
  }
  if (finished) {
    // Converted movies now point to a new file: reload the catalogue.
    ({ movies } = await api('/api/movies'));
    if ($('search-input').value.trim()) renderSearch($('search-input').value);
    else renderRows();
  } else {
    for (const card of document.querySelectorAll('.card[data-id]')) {
      const movie = movies.find((m) => m.id === card.dataset.id);
      if (movie) renderCardConversion(card, movie);
    }
  }
  if (!$('modal').hidden && modalMovie) {
    modalMovie = movies.find((m) => m.id === modalMovie.id) ?? modalMovie;
    renderModalConversion();
  }
  watchConversions();
}
```

In the logout handler, after `progress = {};`:

```js
  clearTimeout(conversionsTimer);
```

- [ ] **Step 4: Run the test suite**

Run: `npm test`
Expected: PASS (no backend change in this task).

- [ ] **Step 5: Manual check in the browser**

Start the smoke library from Task 6 with a longer file (`duration=120`, `touch -t 202001010000 …`), log in (`npm run accounts -- add test test` with the same env), and check:
- the card shows "En attente de conversion", then "Conversion en cours (N %)" with a moving bar;
- the modal's Lecture button is disabled with the same text; the hero never shows the movie;
- when it finishes, the card becomes a normal card without reloading the page, the modal enables Lecture, and the movie plays with sound;
- a broken file (`echo x > "$S/movies/Broken.mkv"`, touched old) shows "Échec de la conversion" and stays clickable.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/js/app.js public/css/style.css
git commit -m "Show conversion status in the catalogue and block playback meanwhile"
```

---

### Task 8: README

**Files:**
- Modify: `README.md` (features list, Notes)

- [ ] **Step 1: Document**

Add a bullet after **Subtitles** in the features list:

```markdown
- **Conversion**: movies browsers can't play are converted in the background with `ffmpeg` to MP4
  (H.264 + AAC) and **replace the original file** (`.mkv`/`.avi`… become `.mp4`; watch progress and
  TMDB data are kept). Containers are remuxed without loss; audio other than AAC/MP3/Opus is
  re-encoded to AAC (every track kept, French as default, 5.1 kept); video other than 8-bit H.264
  (HEVC/x265, 10-bit, MPEG-2, Xvid…) is re-encoded to H.264 CRF 18 (visually lossless, slow: roughly
  1–3 h per 1080p movie on CPU). HDR is tone-mapped to SDR. Embedded text subtitles are extracted to
  `.srt` files next to the movie first. One conversion at a time; the catalogue shows
  "Conversion en cours (X %)" and the movie can't be played meanwhile. Runs at startup on the whole
  library (`CONVERT_ON_START=false` to disable) and on every new movie; a file is only converted once
  its size hasn't changed for 5 s (still being copied otherwise). Converted files, and files found
  already compatible, are recorded in `convert.json` next to `MOVIES_INFOS_PATH` with their size and
  date, so they're never checked again unless they change. A failed conversion keeps the original and
  is retried at the next start.
```

In **Notes**, replace "Browsers play mp4 (H.264/AAC) and webm natively; mkv/avi playback depends on the browser and codecs." with:

```markdown
- Browsers play mp4 (H.264/AAC) natively; other files are converted automatically (see **Conversion**),
  which needs `ffmpeg` and a writable `MOVIES_PATH`. Converted files replace the originals for good.
```

- [ ] **Step 2: Final check**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document automatic conversion"
```
