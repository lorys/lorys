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

/**
 * Turn a filename like "Le.Fabuleux.Destin.d'Amelie.Poulain.2001.1080p.BluRay.x264.mkv"
 * into { title: "Le Fabuleux Destin d'Amelie Poulain", year: 2001 }.
 */
export function parseMovieFilename(filename) {
  let name = path.basename(filename, path.extname(filename));
  name = name.replace(/\[[^\]]*\]/g, ' '); // [release group], [1080p]...
  name = name.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();

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

  const title = name.replace(/[()\[\]{}]/g, ' ').replace(/\s+-\s*$/, '').replace(/\s+/g, ' ').trim();
  return { title: title || path.basename(filename, path.extname(filename)), year };
}
