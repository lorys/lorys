import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  createConversionManager,
  createProgressParser,
  ffmpegArgs,
  planConversion,
  subtitleArgs,
  subtitleSidecarName,
} from '../src/conversions.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { movieId, readMoviesInfos, renameMovieEntry, runExclusive, scanMovies } from '../src/scanner.js';
import { watchMovies } from '../src/watcher.js';

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
  // 10 s: long enough for the truncated copy to miss the 2 s duration tolerance.
  await makeIncompatibleMkv(path.join(config.moviesPath, 'Good.mkv'), { seconds: 10 });
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

test('scans keep the id of a converted movie, and never hand it to a file reusing its old name', async () => {
  // Film.mkv (unmatched on TMDB) was converted to Film.mp4, keeping movieId('Film.mkv') — then a new Film.mkv appears.
  const config = await makeLibrary('ids', [
    { id: movieId('Film.mkv'), file: 'Film.mp4', matched: false, title: 'Film', genres: [] },
  ]);
  await fs.writeFile(path.join(config.moviesPath, 'Film.mp4'), 'x');
  await fs.writeFile(path.join(config.moviesPath, 'Film.mkv'), 'x');
  const noMatch = { searchMovie: async () => null, movieDetails: async () => null };

  await scanMovies(config, { tmdb: noMatch, logger: quiet });
  await scanMovies(config, { tmdb: noMatch, logger: quiet, force: true });
  const { movies } = await readMoviesInfos(config.moviesInfosPath);
  const byFile = Object.fromEntries(movies.map((m) => [m.file, m.id]));
  assert.equal(byFile['Film.mp4'], movieId('Film.mkv'), 'watch progress stays attached');
  assert.notEqual(byFile['Film.mkv'], byFile['Film.mp4'], 'ids stay unique');
});

/** Resolves once the movie's ffmpeg run has started. */
async function untilConverting(conversions, id) {
  for (let i = 0; i < 1000 && conversions.status(id)?.status !== 'converting'; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(conversions.status(id)?.status, 'converting');
}

test('never overwrites a file that appears under the target names during the conversion', { skip: !hasFfmpeg }, async () => {
  const movie = { id: 'late00late00', file: 'Film.mkv' };
  const config = await makeLibrary('late', [movie]);
  await makeIncompatibleMkv(path.join(config.moviesPath, 'Film.mkv'), { seconds: 60 });
  const conversions = createConversionManager(config, { logger: quiet, stableMs: 0 });
  await conversions.enqueue(movie);
  await untilConverting(conversions, movie.id);
  // Downloaded meanwhile: another movie, and a subtitle file of its own.
  await fs.writeFile(path.join(config.moviesPath, 'Film.mp4'), 'another movie');
  await fs.writeFile(path.join(config.moviesPath, 'Film (1).fr.srt'), 'my subtitles');
  await conversions.idle();

  assert.equal(await fs.readFile(path.join(config.moviesPath, 'Film.mp4'), 'utf8'), 'another movie');
  assert.equal(await fs.readFile(path.join(config.moviesPath, 'Film (1).fr.srt'), 'utf8'), 'my subtitles');
  assert.match(await fs.readFile(path.join(config.moviesPath, 'Film (1).fr.2.srt'), 'utf8'), /Bonjour/);
  const { movies } = await readMoviesInfos(config.moviesInfosPath);
  assert.equal(movies.find((m) => m.id === movie.id).file, 'Film (1).mp4');
});

test('a source replaced during the conversion is kept and converted again', { skip: !hasFfmpeg }, async () => {
  const movie = { id: 'swap00swap00', file: 'Film.mkv' };
  const config = await makeLibrary('replaced', [movie]);
  await makeIncompatibleMkv(path.join(config.moviesPath, 'Film.mkv'), { seconds: 60 });
  const better = path.join(dir, 'replaced', 'better.mkv');
  await makeIncompatibleMkv(better, { seconds: 3 });
  const conversions = createConversionManager(config, { logger: quiet, stableMs: 0 });
  await conversions.enqueue(movie);
  await untilConverting(conversions, movie.id);
  await fs.copyFile(better, path.join(config.moviesPath, 'Film.mkv')); // a better release, copied over it
  await conversions.idle();

  const { format } = await probe(path.join(config.moviesPath, 'Film.mp4'));
  assert.ok(Math.abs(Number(format.duration) - 3) < 0.5, `the new file was converted (got ${format.duration} s)`);
  assert.equal(conversions.status(movie.id), null);
});
