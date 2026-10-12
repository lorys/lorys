# Cinéflix

A Netflix-like streaming site for a local movie folder, served with Fastify. No database.

- **Movies**: every video file in `MOVIES_PATH` (recursive: mp4, m4v, mkv, webm, mov, avi, ogv).
- **Metadata**: each filename is parsed (title + year, release tags stripped) and looked up on
  themoviedb.org **in French**; results are stored in `MOVIES_INFOS_PATH`.
- **Series**: files named like `Show.S01E02…`, `Show.1x02…` or `Show.S01E01E02…` (the folder doesn't
  matter) are episodes. They're grouped by show and looked up on TMDB's TV database (one lookup per show
  and per season, in French). Shows have their own "Séries" row; their modal lists episodes by season,
  and the player offers "Épisode suivant" with a 10 s countdown over the credits. Episodes watched to the
  end are remembered per account (`watched` in the accounts file) to know where to pick a show up.
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
- **Conversion**: movies browsers can't play are converted in the background with `ffmpeg` to MP4
  (H.264 + AAC) and **replace the original file** (`.mkv`/`.avi`… become `.mp4`; watch progress and
  TMDB data are kept). Containers are remuxed without loss; audio other than AAC/MP3/Opus is
  re-encoded to AAC (every track kept, French as default, 5.1 kept); video other than 8-bit H.264
  (HEVC/x265, 10-bit, MPEG-2, Xvid…) is re-encoded to H.264, with Intel Quick Sync (VAAPI, `VAAPI_DEVICE`)
  when ffmpeg can use it, otherwise on the CPU (libx264 CRF 18, preset veryfast); a file Quick Sync fails on
  is retried on the CPU. Video bigger than 1080p (4K) is downscaled to fit 1920×1080. HDR is tone-mapped to SDR. Embedded text subtitles are extracted to
  `.srt` files next to the movie first. One conversion at a time; the catalogue shows
  "Conversion en cours (X %)" and the movie can't be played meanwhile. Runs at startup on the whole
  library (`CONVERT_ON_START=false` to disable) and on every new movie; a file is only converted once
  its size hasn't changed for 5 s (still being copied otherwise). Converted files, and files found
  already compatible, are recorded in `convert.json` next to `MOVIES_INFOS_PATH` with their size and
  date, so they're never checked again unless they change. A failed conversion keeps the original and
  is retried once the file changes, or at the next start.
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
| `npm run scan [-- --force]` | Sync `MOVIES_INFOS_PATH` now; `--force` refreshes every movie and show from TMDB |
| `npm run accounts -- add <user> <pass>` | Create a user or change their password (stored as a scrypt hash) |
| `npm run accounts -- remove <user>` / `list` | |
| `npm run accounts -- import <plain.json>` | Encrypt an existing `[{ username, password }]` file |
| `npm run accounts -- export` | Print the decrypted accounts |
| `npm test` | Run the tests |

## Notes

- Browsers play mp4 (H.264/AAC) natively; other files are converted automatically (see **Conversion**),
  which needs `ffmpeg` and a writable `MOVIES_PATH`. Converted files replace the originals for good.
- Docker with Quick Sync: pass the Intel GPU's render node and its group to the container (the app runs
  as `node`), e.g. `--device "$(readlink -f /dev/dri/by-path/pci-0000:00:02.0-render)":/dev/dri/renderD128
  --group-add "$(getent group render | cut -d: -f3)"` (Docker can't take the by-path name itself: it has colons). The log says at startup whether VAAPI is used.
- Extracting an embedded subtitle track reads the whole video file, so the first time a track is
  picked on a large mkv it can take a little while before the subtitles appear.
- Downloads need `MOVIES_PATH` to be writable. Any logged-in user can make the server fetch an
  arbitrary http(s) URL, so only give accounts to people you trust.
- Files TMDB can't identify still appear (under "Autres") with the title parsed from the filename.
  Rename the file to fix the match, or run `npm run scan -- --force`.
