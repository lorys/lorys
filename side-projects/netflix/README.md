# Cinéflix

A Netflix-like streaming site for a local movie folder, served with Fastify. No database.

- **Movies**: every video file in `MOVIES_PATH` (recursive: mp4, m4v, mkv, webm, mov, avi, ogv).
- **Metadata**: each filename is parsed (title + year, release tags stripped) and looked up on
  themoviedb.org **in French**; results are stored in `MOVIES_INFOS_PATH`.
- **Automatic sync**: the server watches `MOVIES_PATH` (fs events + a poll every minute) and rescans
  as soon as the set of files differs from `MOVIES_INFOS_PATH`. Scans are incremental: only new
  files (and previously unmatched ones) hit TMDB.
- **Accounts**: `{ "username", "password" }[]` encrypted with AES-256-GCM in `ACCOUNTS_PATH`.
- **Watch progress**: saved every 10 s while a movie plays (and on pause / close) into the user's
  entry of the accounts file, as `progress: { [movieId]: { position, duration, updatedAt } }`.
  Started movies show a red progress bar, appear in "Reprendre la lecture", and can be resumed or
  restarted; progress is cleared once only the credits are left (last 5%, at least 1 min).
- **Downloads**: press <kbd>Enter</kbd> on the catalogue to open the download modal, paste a video
  link and press Enter again. Each link gets its own progress bar and several can run in parallel.
  The server streams the file to `MOVIES_PATH/<name>.part` and renames it when complete, so the
  watcher picks it up automatically. The name comes from `Content-Disposition` or the URL; links
  that don't look like a video file are rejected.
- **Player**: Netflix-style controls (auto-hiding, red scrubber with time preview, ±10 s, volume,
  playback speed, fullscreen, "Vous regardez" screen when paused). Keys: <kbd>Space</kbd>/<kbd>K</kbd>
  play/pause, <kbd>←</kbd>/<kbd>→</kbd> ±10 s, <kbd>↑</kbd>/<kbd>↓</kbd> volume, <kbd>M</kbd> mute,
  <kbd>F</kbd> fullscreen, <kbd>Esc</kbd> back. Volume and subtitle language are remembered per browser.
- **Subtitles**: `.srt`/`.vtt` files next to the video (`Movie.fr.srt`, `Movie.en.forced.srt`, or any
  file in a `Subs/` folder when the video is alone in its folder), plus text tracks embedded in the
  video when `ffmpeg` is installed. SRT files are converted to WebVTT on the fly (UTF-8 or
  Windows-1252); embedded tracks are extracted once and cached in `subtitles/` next to
  `MOVIES_INFOS_PATH`. Image-based tracks (PGS/VobSub) aren't supported.
- **Frontend**: categories (recently added, top rated, one row per genre) and a fuzzy search
  based on the Damerau-Levenshtein distance (`public/js/search.js`).

## Setup

```sh
npm install
cp .env.example .env   # then fill it in
npm run accounts -- add <username> <password>
npm start              # http://localhost:3000
```

## Commands

| Command | |
| --- | --- |
| `npm start` / `npm run dev` | Start the server (dev = restart on code change) |
| `npm run scan [-- --force]` | Sync `MOVIES_INFOS_PATH` now; `--force` refreshes every movie from TMDB |
| `npm run accounts -- add <user> <pass>` | Create a user or change their password (stored as a scrypt hash) |
| `npm run accounts -- remove <user>` / `list` | |
| `npm run accounts -- import <plain.json>` | Encrypt an existing `[{ username, password }]` file |
| `npm run accounts -- export` | Print the decrypted accounts |
| `npm test` | Run the tests |

## Notes

- Browsers play mp4 (H.264/AAC) and webm natively; mkv/avi playback depends on the browser and codecs.
- Extracting an embedded subtitle track reads the whole video file, so the first time a track is
  picked on a large mkv it can take a little while before the subtitles appear.
- Downloads need `MOVIES_PATH` to be writable. Any logged-in user can make the server fetch an
  arbitrary http(s) URL, so only give accounts to people you trust.
- Files TMDB can't identify still appear (under "Autres") with the title parsed from the filename.
  Rename the file to fix the match, or run `npm run scan -- --force`.
