# Automatic conversion of movies browsers can't play

Date: 2026-10-11

## Goal

Some movies can't be played in Chrome or other browsers (no image or no sound) because of their
container or codecs. The server detects these files and converts them to a format every browser
plays, then **replaces the original file**. While a movie is waiting or being converted, the
frontend shows "Conversion en cours (X %)" and the movie can't be played.

Conversions happen:
- at startup, for every movie in the library that needs one;
- whenever a new movie appears (download or file copied by hand).

Quality must not visibly degrade.

## Decisions

| Topic | Decision |
| --- | --- |
| Target container | MP4 (`-movflags +faststart`). `.mkv`, `.avi`, `.mov`, `.webm`, `.ogv` become `.mp4` |
| Video | H.264 8-bit 4:2:0 (`yuv420p`) is copied. Anything else (HEVC, 10-bit H.264, MPEG-2, Xvid, VP9, AV1…) is re-encoded with `libx264 -crf 18 -preset slow -pix_fmt yuv420p`, same resolution and frame rate |
| HDR | HDR sources (PQ/HLG transfer) are tone-mapped to SDR BT.709 during re-encoding (`zscale` + `tonemap`). Known limitation: colours differ from an HDR display |
| Audio | **Every** track is kept. AAC, MP3 and Opus are copied. Others (AC3, E-AC3, DTS, TrueHD, FLAC, PCM, Vorbis…) are re-encoded to AAC: 256 kb/s for ≤ 2 channels, 640 kb/s for more. 5.1 stays 5.1; layouts above 6 channels are downmixed to 5.1 |
| Default audio | The first French track (`fre`/`fra`/`fr`) is the default; if there is none, the source's default track (or the first one) |
| Subtitles | Embedded text tracks (`subrip`, `ass`, `ssa`, `mov_text`, `webvtt`, `text`) are extracted to sidecar `.srt` files next to the new file before the original is deleted. Bitmap tracks (PGS, VobSub) are dropped (already not supported by the player) |
| Other streams | Attachments (fonts), data streams and cover images are dropped |
| Concurrency | One conversion at a time |
| Playback during conversion | Refused (HTTP 409) while the movie is queued or converting |
| Stable files only | A file is converted only once its size hasn't changed for 5 s (checked before probing and again before converting). A file modified more than 5 s ago is stable right away |
| Tracking | `convert.json` (next to `MOVIES_INFOS_PATH`) records every converted file, and files found already compatible, with their size and mtime. A file with a matching entry is never probed or converted again |
| Failure | The original is kept, the movie is marked `failed`; retried at the next startup, or earlier if the file changed |

A file whose plan is empty (already MP4/M4V, H.264 8-bit, only AAC/MP3/Opus audio) isn't touched.

## Architecture

### `src/conversions.js` (new)

Built like `src/downloads.js`: a factory returning a manager with an in-memory state.

Pure, exported, unit-tested functions:
- `planConversion(probe, file)` → `null` (nothing to do) or
  `{ video: 'copy' | 'x264', hdr: boolean, audio: [{ index, action: 'copy' | 'aac', bitrate, channels, isDefault }], subtitles: [{ index, lang, forced }], outputFile }`.
  `probe` is the JSON from `ffprobe -show_streams -show_format`.
- `ffmpegArgs(plan, inputPath, outputPath)` → ffmpeg argument array
  (`-map` for each kept stream, codecs, `-disposition:a:N default`, `-progress pipe:1 -nostats`).
- `parseProgress(chunk)` → `out_time` seconds from ffmpeg's `-progress` output.
- `subtitleSidecarName(videoFile, track, taken)` → `Film.fr.srt`, `Film.en.forced.srt`, `Film.2.srt`
  when the name is already used (follows the naming read by `src/subtitles.js`).

`createConversionManager(config, { logger, renameMovie })` returns:
- `enqueue(movie)`: skips the movie (`{ id, file }`) if `convert.json` has an entry for its file with the
  same size and mtime, or if it's already queued/running (or failed and unchanged). Otherwise waits until
  the file is stable (5 s rule), probes it, records it in `convert.json` as compatible when its plan is
  `null`, or adds it to the conversion queue. Probe results are also cached in memory by
  `file + size + mtime`.
- `status(id)` → `{ status: 'queued' | 'converting' | 'failed', percent, error }` or `null`.
- `list()` → `{ [movieId]: { status, percent, error } }`.
- `isBusy(id)` → true if queued or converting.
- `cleanup()`: deletes leftover `.*.converting.mp4` files in `MOVIES_PATH` (crash recovery), called at startup.
- `close()`: kills the running ffmpeg, deletes its temp file, empties the queue.

Only movies that need a conversion ever get a status, so compatible movies never show
"En attente de conversion", even while a long conversion is running.

### Converting one file

1. Wait until the source is stable again (it may have changed while queued); re-probe and rebuild the plan
   if size/mtime changed; stop if the plan is now `null`.
2. Extract each embedded text subtitle track to its sidecar `.srt` (written as a hidden temp file, renamed
   once all tracks succeed).
3. Run `ffmpeg` to `.<name>.converting.mp4` in the same folder (leading dot: ignored by the scanner's
   `walk`). Progress = `out_time / format.duration`, clamped to 0–99 until done.
4. `ffprobe` the output: it must have one H.264 video stream and as many audio streams as planned, and its
   duration must be within 2 s of the source's.
5. Rename the temp file to `<name>.mp4`. If that name is already used by another file, use
   `<name> (1).mp4`, etc. Delete the original if its path differs.
6. Call `renameMovie(oldFile, newFile)` so `movies.json` keeps the same entry.
7. Record the new file in `convert.json` (`converted: true`, `source: oldFile`).

### Tracking — `convert.json`

Path: `path.join(path.dirname(MOVIES_INFOS_PATH), 'convert.json')` (the data folder, outside `MOVIES_PATH`).

```json
{
  "files": {
    "d/Film.mp4": { "size": 1234, "mtimeMs": 1577934245000, "converted": true, "source": "d/Film.mkv", "at": "2026-10-11T12:00:00.000Z" },
    "Ok.mp4": { "size": 999, "mtimeMs": 1577934245000, "converted": false, "at": "2026-10-11T12:00:00.000Z" }
  }
}
```

- Keyed by the file path relative to `MOVIES_PATH`. `converted: false` means the file was already playable.
- An entry only counts when `size` and `mtimeMs` match the file on disk; otherwise the file is checked again
  (and its entry overwritten).
- Written atomically (temp file + rename), writes serialised. Missing or corrupted file = empty (with a
  warning). Failures aren't recorded.
- The converted file keeps the original's mtime, and its entry stores the mtime after that change.

On any error: kill ffmpeg if still running, delete the temp file and any extracted sidecar temp files,
keep the original, set `failed` with the error message (stderr's last line for ffmpeg errors).

### Keeping the movie identity — `src/scanner.js`

New `renameMovieEntry(config, oldFile, newFile)`: rewrites `movies.json` changing the entry's `file`
(and `size`/`addedAt` stay as the scanner sets them on the next scan). The `id` is unchanged, so watch
progress (keyed by id) and TMDB data are kept and TMDB isn't queried again.

`scanMovies` already reuses entries by `file`, so after the rename the next scan sees the `.mp4` as known.

### Watcher integration — `src/watcher.js`

- The watcher exposes `runExclusive(fn)`, using the same `running` lock as scans, so
  `renameMovieEntry` never races a scan. `renameMovie` passed to the conversion manager goes through it.
  The watcher must not see the library as changed between steps 5 and 6 and rescan: the check runs under
  the lock, so it waits until `movies.json` is updated.
- After each scan, the watcher calls an `onScanned(movies)` callback. `index.js` uses it to enqueue every
  movie in the library; the manager ignores those already handled (probe cache).

### Startup — `src/index.js`

1. `conversions.cleanup()` (`convert.json` is loaded lazily on the first `enqueue`).
2. If `CONVERT_ON_START` (default `true`): enqueue every movie from `movies.json`, after the startup scan
   when `SCAN_ON_START` is set.
3. Pass the watcher's `onScanned` → `enqueue`.
4. On SIGINT/SIGTERM: `conversions.close()` before closing the app.

If `ffmpeg`/`ffprobe` aren't installed, the manager logs one warning and every method is a no-op.

### Config — `src/config.js`

`convertOnStart: env.CONVERT_ON_START !== 'false'`. Documented in `.env.example`.

## API — `src/app.js`

`buildApp(config, { conversions })` receives the manager (tests pass a fake).

- `GET /api/movies`: movies with a status get `conversion: { status, percent, error }`.
- `GET /api/conversions` (logged in): `conversions.list()`.
- `GET /api/movies/:id/stream`: `409 { error: 'Conversion en cours' }` when `conversions.isBusy(id)`.

`MIME_TYPES` and range handling stay as they are.

## Frontend — `public/js/app.js`, `public/index.html`, `public/css/style.css`

- **Card:** when `movie.conversion` is set, a dark overlay on the poster with
  "Conversion en cours (42 %)", "En attente de conversion" or "Échec de la conversion", and a thin bar
  (same style as the watch progress bar) showing the percentage.
- **Modal:** the "Lecture"/"Reprendre" buttons are disabled and show the same text; a failed conversion
  shows the error as a tooltip.
- **Hero:** movies with `conversion` set aren't picked.
- **Polling:** while at least one movie has `queued`/`converting`, poll `GET /api/conversions` every 3 s
  and update cards and the open modal in place. When a movie disappears from the list, reload
  `/api/movies` and re-render, so the card points to the new file.

## Docker / docs

- Dockerfile: update the comments (ffmpeg also converts videos; `/movies` must be writable).
- README: a "Conversion" section — what is converted, that originals are **replaced permanently**,
  that re-encoding video takes a long time (about 1–3 h per 1080p movie on CPU), HDR tone mapping,
  `CONVERT_ON_START`; and update the note "mkv/avi playback depends on the browser".

## Tests — `test/conversions.test.js`

Unit (no ffmpeg needed):
- `planConversion`: H.264 + AAC mp4 → `null`; H.264 + AAC mkv → remux to `.mp4`; HEVC → x264;
  H.264 10-bit → x264; HDR HEVC → x264 + tone mapping; AC3 5.1 → AAC 640k 6 ch; DTS 7.1 → AAC 5.1;
  French track made default when it isn't first; text subtitles kept for extraction, PGS ignored.
- `ffmpegArgs`: expected arguments for a remux and for a full re-encode.
- `parseProgress`: `out_time_us`/`out_time` lines, partial chunks.
- `subtitleSidecarName`: language/forced suffixes and name collisions.
- `renameMovieEntry`: entry keeps its `id` and other fields.
- Tracking: `convert.json` gets the converted file (`converted: true`) and compatible files
  (`converted: false`); a new manager doesn't probe tracked files again, but does once the file changed.
- Stability: a file whose size changes during the 5 s window isn't probed until it stops changing.

Integration (skipped when ffmpeg isn't installed): generate a 2 s HEVC + AC3 mkv with a French and an
English audio track and an SRT track (`testsrc`, `sine`); run the manager; check the `.mkv` is gone,
the `.mp4` is H.264/AAC with 2 audio tracks and French default, a `.fr.srt` sidecar exists, the
`movies.json` entry kept its `id`, and no temp file is left. A failing conversion (corrupted input)
keeps the original and reports `failed`.

API (`app.inject` with a fake manager): `/stream` → 409 when busy; `/api/movies` includes `conversion`;
`/api/conversions` requires login.

## Out of scope

- Audio track picker in the player.
- Hardware-accelerated encoding.
- Converting bitmap subtitles (OCR).
- Resuming an interrupted conversion (it restarts from the beginning).
