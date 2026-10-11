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
