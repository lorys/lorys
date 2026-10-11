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
