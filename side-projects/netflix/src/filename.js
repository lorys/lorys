import path from 'node:path';

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.ogv']);

// Release tags that mark the end of the title in scene-style filenames.
const STOP_TAGS = new RegExp(
  '\\b(' +
    [
      '2160p', '1080p', '720p', '576p', '480p', '4k', 'uhd', 'hdr10?', 'dv', 'sdr',
      'bluray', 'blu-ray', 'bdrip', 'brrip', 'dvdrip', 'dvdscr', 'webrip', 'web-dl', 'webdl', 'web', 'hdtv', 'hdrip', 'remux',
      'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', 'av1', '10bit',
      'aac', 'ac3', 'dts', 'ddp?5\\.1', 'truehd', 'atmos',
      'multi', 'vff', 'vfq', 'vfi', 'vf2', 'vf', 'vostfr', 'vo', 'truefrench', 'french', 'subfrench',
      'proper', 'repack', 'extended', 'unrated', 'remastered', 'directors\\.?cut', 'imax', 'internal', 'limited',
    ].join('|') +
    ')\\b',
  'i',
);

// S01E02, S1E2, S01 E02, S01E01E02, S01E01-E02, S01E01-02, 1x02, 1x02-03 (after dots/underscores became spaces).
const EPISODE_MARKER =
  /(?:^|[\s-])(?:s(\d{1,2}) ?e(\d{1,3})(?:-?e(\d{1,3})|-(\d{1,3})(?=[\s-]|$))?|(\d{1,2})x(\d{2,3})(?:-(\d{2,3}))?)(?=[\s-]|$)/i;

/** Basename without extension, [tags] removed, dots/underscores turned into single spaces. */
function cleanName(filename) {
  let name = path.basename(filename, path.extname(filename));
  name = name.replace(/\[[^\]]*\]/g, ' '); // [release group], [1080p]...
  return name.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tidyTitle(name) {
  return name.replace(/[()\[\]{}]/g, ' ').replace(/\s+-\s*$/, '').replace(/\s+/g, ' ').trim();
}

/**
 * Turn a filename like "Le.Fabuleux.Destin.d'Amelie.Poulain.2001.1080p.BluRay.x264.mkv"
 * into { title: "Le Fabuleux Destin d'Amelie Poulain", year: 2001 }.
 */
export function parseMovieFilename(filename) {
  let name = cleanName(filename);

  let year = null;
  const yearMatches = [...name.matchAll(/(?:^|[\s(\[-])((?:19|20)\d{2})(?=$|[\s)\]-])/g)];
  // Use the last year-looking token that isn't at the very start ("2001 A Space Odyssey 1968").
  const yearMatch = yearMatches.filter((m) => m.index > 0).at(-1);
  if (yearMatch) {
    year = Number(yearMatch[1]);
    name = name.slice(0, yearMatch.index);
  }

  const tag = name.match(STOP_TAGS);
  if (tag && tag.index > 0) name = name.slice(0, tag.index);

  const title = tidyTitle(name);
  return { title: title || path.basename(filename, path.extname(filename)), year };
}

/**
 * Turn "Breaking.Bad.S01E02.1080p.WEB.x264.mkv" into
 * { showTitle: "Breaking Bad", year: null, season: 1, episode: 2, episodeEnd: 2 }.
 * Returns null when the name has no episode marker or no show name before it.
 */
export function parseEpisodeFilename(filename) {
  const name = cleanName(filename);
  const marker = name.match(EPISODE_MARKER);
  if (!marker) return null;
  const season = Number(marker[1] ?? marker[5]);
  const episode = Number(marker[2] ?? marker[6]);
  const end = Number(marker[3] ?? marker[4] ?? marker[7] ?? episode);

  let title = name.slice(0, marker.index).replace(/[\s-]+$/, '');
  let year = null;
  // "Doctor Who 2005" / "Doctor Who (2005)": the year tells remakes apart on TMDB.
  const yearMatch = title.match(/\s\(?((?:19|20)\d{2})\)?$/);
  if (yearMatch) {
    year = Number(yearMatch[1]);
    title = title.slice(0, yearMatch.index);
  }
  const tag = title.match(STOP_TAGS);
  if (tag && tag.index > 0) title = title.slice(0, tag.index);

  const showTitle = tidyTitle(title);
  if (!showTitle) return null;
  return { showTitle, year, season, episode, episodeEnd: Math.max(end, episode) };
}

/** Groups episodes of the same show: "Le Bureau des Légendes" → "le bureau des legendes". */
export function showKey(title) {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
