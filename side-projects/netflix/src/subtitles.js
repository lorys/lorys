import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt']);
// Folders release groups put subtitles in, next to the video.
const SUBTITLE_DIRS = new Set(['subs', 'sub', 'subtitles', 'sous-titres', 'st']);
// Embedded codecs ffmpeg can turn into WebVTT (bitmap ones like PGS/VobSub can't).
const TEXT_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

const LANGUAGE_ALIASES = {
  fr: 'fr', fre: 'fr', fra: 'fr', french: 'fr', francais: 'fr', vf: 'fr', vff: 'fr', vfq: 'fr', vostfr: 'fr', vf2: 'fr',
  en: 'en', eng: 'en', english: 'en', anglais: 'en',
  es: 'es', spa: 'es', spanish: 'es', espanol: 'es',
  de: 'de', ger: 'de', deu: 'de', german: 'de',
  it: 'it', ita: 'it', italian: 'it',
  pt: 'pt', por: 'pt', portuguese: 'pt',
  nl: 'nl', dut: 'nl', nld: 'nl', dutch: 'nl',
  ja: 'ja', jpn: 'ja', japanese: 'ja',
  ko: 'ko', kor: 'ko', korean: 'ko',
  zh: 'zh', chi: 'zh', zho: 'zh', chinese: 'zh',
  ar: 'ar', ara: 'ar', arabic: 'ar',
  ru: 'ru', rus: 'ru', russian: 'ru',
};

const languageNames = new Intl.DisplayNames('fr', { type: 'language' });

function capitalize(text) {
  return text.charAt(0).toLocaleUpperCase('fr') + text.slice(1);
}

/** Language code and flags from the tokens of "Movie.fr.forced.srt" or an ffprobe stream. */
export function describeSubtitle(tokens) {
  const words = tokens.map((t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
  const lang = words.map((w) => LANGUAGE_ALIASES[w]).findLast(Boolean) ?? null;
  return {
    lang,
    forced: words.includes('forced') || words.includes('force'),
    sdh: words.some((w) => ['sdh', 'cc', 'hi'].includes(w)),
  };
}

export function subtitleLabel({ lang, forced, sdh, title }) {
  let label = lang ? capitalize(languageNames.of(lang)) : title || 'Sous-titres';
  if (forced) label += ' (forcés)';
  else if (sdh) label += ' [CC]';
  return label;
}

/** Subtitle files belonging to `videoFile`: same base name, or anything in a Subs folder / alone with the video. */
export async function findSidecarSubtitles(moviesPath, videoFile) {
  const dir = path.dirname(path.join(moviesPath, videoFile));
  const base = path.basename(videoFile, path.extname(videoFile)).toLowerCase();
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const videosInDir = entries.filter((e) => e.isFile() && /\.(mp4|m4v|mkv|webm|mov|avi|ogv)$/i.test(e.name)).length;

  const found = [];
  const consider = (full, name, { loose }) => {
    const ext = path.extname(name).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.has(ext)) return;
    const stem = path.basename(name, ext);
    const matchesVideo = stem.toLowerCase().startsWith(base);
    if (!matchesVideo && !loose) return;
    const rest = matchesVideo ? stem.slice(base.length) : stem;
    found.push({ path: full, ...describeSubtitle(rest.split(/[.\s_\-\[\]()]+/).filter(Boolean)) });
  };

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) consider(full, entry.name, { loose: videosInDir === 1 });
    else if (entry.isDirectory() && SUBTITLE_DIRS.has(entry.name.toLowerCase())) {
      for (const sub of await fs.readdir(full, { withFileTypes: true }).catch(() => [])) {
        if (sub.isFile()) consider(path.join(full, sub.name), sub.name, { loose: videosInDir === 1 });
      }
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** Decode a subtitle file: UTF-8 (with or without BOM), else Windows-1252, common for French .srt files. */
export function decodeSubtitle(buffer) {
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buffer) : utf8.replace(/^﻿/, '');
}

export function srtToVtt(srt) {
  const body = srt
    .replace(/\r\n?/g, '\n')
    .trim()
    .replace(/(\d{1,2}:\d{2}:\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2})[,.](\d{3})/g, '$1.$2 --> $3.$4')
    // SubRip font tags and ASS-style {\an8} overrides aren't valid WebVTT.
    .replace(/<\/?font[^>]*>/gi, '')
    .replace(/\{\\[^}]*\}/g, '');
  return `WEBVTT\n\n${body}\n`;
}

let ffprobeAvailable = null;

async function hasFfmpeg() {
  if (ffprobeAvailable === null) {
    ffprobeAvailable = await run('ffprobe', ['-version']).then(() => true, () => false);
  }
  return ffprobeAvailable;
}

/** Text subtitle streams embedded in the video (mkv/mp4), when ffprobe is installed. */
export async function findEmbeddedSubtitles(videoPath) {
  if (!(await hasFfmpeg())) return [];
  try {
    const { stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-select_streams', 's', '-show_entries', 'stream=index,codec_name:stream_tags=language,title:stream_disposition=forced,hearing_impaired', '-of', 'json', videoPath],
      { timeout: 15_000 },
    );
    return (JSON.parse(stdout).streams ?? [])
      .filter((s) => TEXT_CODECS.has(s.codec_name))
      .map((s) => {
        const title = s.tags?.title ?? '';
        const described = describeSubtitle([...title.split(/\W+/), s.tags?.language ?? ''].filter(Boolean));
        return {
          stream: s.index,
          title,
          lang: described.lang,
          forced: Boolean(s.disposition?.forced) || described.forced,
          sdh: Boolean(s.disposition?.hearing_impaired) || described.sdh,
        };
      });
  } catch {
    return [];
  }
}

/** Lists and serves the subtitles of a movie; embedded tracks are extracted once and cached in `cacheDir`. */
export function createSubtitlesService(moviesPath, cacheDir) {
  const extracting = new Map();

  async function list(movie) {
    const videoPath = path.join(moviesPath, movie.file);
    const [sidecars, embedded] = await Promise.all([findSidecarSubtitles(moviesPath, movie.file), findEmbeddedSubtitles(videoPath)]);
    return [
      ...sidecars.map((s, i) => ({ id: `f${i}`, lang: s.lang, forced: s.forced, label: subtitleLabel(s), path: s.path })),
      ...embedded.map((s) => ({ id: `e${s.stream}`, lang: s.lang, forced: s.forced, label: subtitleLabel(s), stream: s.stream })),
    ];
  }

  async function extract(movie, track) {
    const videoPath = path.join(moviesPath, movie.file);
    const { mtimeMs } = await fs.stat(videoPath);
    const cached = path.join(cacheDir, `${movie.id}-${track.stream}-${Math.round(mtimeMs)}.vtt`);
    try {
      return await fs.readFile(cached, 'utf8');
    } catch {}
    // ffmpeg reads the whole file to extract a track: share one run between concurrent requests.
    if (!extracting.has(cached)) {
      const job = run('ffmpeg', ['-v', 'error', '-i', videoPath, '-map', `0:${track.stream}`, '-f', 'webvtt', '-'], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 10 * 60_000,
      })
        .then(async ({ stdout }) => {
          await fs.mkdir(cacheDir, { recursive: true });
          await fs.writeFile(cached, stdout);
          return stdout;
        })
        .finally(() => extracting.delete(cached));
      extracting.set(cached, job);
    }
    return extracting.get(cached);
  }

  async function read(movie, track) {
    if (track.stream !== undefined) return extract(movie, track);
    const text = decodeSubtitle(await fs.readFile(track.path));
    return path.extname(track.path).toLowerCase() === '.vtt' ? text : srtToVtt(text);
  }

  return { list, read };
}
