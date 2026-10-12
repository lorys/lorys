# TV series support

Date: 2026-10-12

## Goal

Today every video file is treated as a movie: an episode like `Breaking.Bad.S01E02.1080p.WEB.x264.mkv`
is searched on TMDB as the movie "Breaking Bad S01E02", usually ends up in "Autres" (or worse, matches an
unrelated film), and each episode is its own tile.

After this change, episodes are recognised from their filename, grouped by show, described with TMDB's TV
data (in French), browsed by season in the modal, and played one after the other with a Netflix-style
"Épisode suivant" countdown.

Series files arrive as loose, scene-named files directly in `MOVIES_PATH` (mostly through the download
modal): detection relies on the filename only, folder names are ignored.

## Decisions

| Topic | Decision |
| --- | --- |
| Detection | Filename only. `S01E02`, `S1E2`, `s01e02`, `1x02`, multi-episode `S01E01E02` / `S01E01-E02` / `S01E01-02`. No marker → movie, handled exactly like today |
| Multi-episode files | One entry, filed under its first episode; `episodeEnd` records the last one ("É1-2") |
| Show identity | A key derived from the parsed show title (lowercased, accents and punctuation stripped, spaces collapsed). A year before the marker (`Doctor.Who.2005.S01E01`) is a search hint, not part of the key |
| Metadata | TMDB `/search/tv` (year hint as `first_air_date_year`, retried without), `/tv/{id}`, `/tv/{id}/season/{n}`, language `fr-FR`. One show lookup per show and one season lookup per season, per scan |
| Storage | Episodes stay entries of `movies` in `MOVIES_INFOS_PATH` (own `id`, `file`), with `kind: "episode"`. Show data goes in a new top-level `shows` object |
| Unmatched show | Episodes are still grouped under the parsed show title, without artwork; retried on the next scan like unmatched movies |
| Catalogue | One tile per show, only in a dedicated "Séries" row (genre rows, "Ajoutés récemment", "Les mieux notés", "Autres" stay movies-only). "Reprendre la lecture" shows the show tile. Search returns movies and shows |
| Modal | Show info, season selector, episode list (number, title, synopsis, runtime, still, progress bar, conversion status) |
| Play button | Resumes the in-progress episode, otherwise plays the episode after the last one finished, otherwise the first |
| End of an episode | Over the credits (same threshold as `isFinished`: last 5%, at least 60 s) an "Épisode suivant" button with a 10 s countdown appears; it plays the next playable episode from the start. Back/Esc cancels. After the last available episode the player closes, like movies |
| Watched episodes | New per-account `watched: { [id]: finishedAt }`, set when progress is saved as finished. Needed because finished progress is deleted |

Everything keyed by item id or file (streaming, subtitles, conversion, `convert.json`, `renameMovieEntry`,
watch progress, downloads, watcher) keeps working unchanged for episodes.

## Architecture

### `src/filename.js`

New `parseEpisodeFilename(file)` → `null` when there is no episode marker, otherwise
`{ showTitle, year, season, episode, episodeEnd }` (`episodeEnd` equals `episode` for single episodes).
The show title is the text before the marker, cleaned like movie titles (brackets, dots/underscores,
release tags). Only the basename is used.

New `showKey(title)` → normalised key (`"breaking bad"`).

`parseMovieFilename` is unchanged.

### `src/tmdb.js`

Adds to the client:
- `searchTv(title, year)` → first result or `null` (retry without year, like `searchMovie`);
- `tvDetails(id)` → `/tv/{id}` (`name`, `original_name`, `overview`, `poster_path`, `backdrop_path`,
  `genres`, `vote_average`, `first_air_date`);
- `seasonDetails(id, season)` → `/tv/{id}/season/{n}` (`episodes[]`: `episode_number`, `name`,
  `overview`, `still_path`, `runtime`, `air_date`).

### `src/scanner.js`

`scanMovies` splits files into movies (unchanged path) and episodes (`parseEpisodeFilename` non-null).

`MOVIES_INFOS_PATH` gains `shows`:

```json
{
  "updatedAt": "…",
  "movies": [ …movies and episodes… ],
  "shows": {
    "breaking bad": {
      "key": "breaking bad",
      "matched": true,
      "tmdbId": 1396,
      "title": "Breaking Bad",
      "originalTitle": "Breaking Bad",
      "overview": "…",
      "posterPath": "/…jpg",
      "backdropPath": "/…jpg",
      "genres": ["Drame", "Crime"],
      "voteAverage": 8.9,
      "firstAirYear": 2008,
      "seasons": {
        "1": { "1": { "name": "…", "overview": "…", "stillPath": "/…jpg", "runtime": 58, "airDate": "2008-01-20" } }
      },
      "lookedUpAt": "…"
    }
  }
}
```

`seasons` only holds seasons that have at least one file. An unmatched show has `matched: false`,
`tmdbId: null`, `title` = parsed show title, empty/null metadata and `seasons: {}`.

Episode entries keep the movie shape so existing code (API filtering, search, subtitles…) can read them:

```json
{
  "id": "…", "file": "Breaking.Bad.S01E02.1080p.WEB.x264.mkv", "size": 0, "addedAt": "…",
  "kind": "episode", "showKey": "breaking bad", "season": 1, "episode": 2, "episodeEnd": 2,
  "matched": true, "tmdbId": null,
  "title": "Le Chat est dans le sac…", "originalTitle": null, "overview": "…", "tagline": "",
  "releaseDate": "2008-01-27", "year": 2008, "runtime": 48, "stillPath": "/…jpg",
  "genres": [], "voteAverage": null, "posterPath": null, "backdropPath": null,
  "director": null, "cast": [], "parsed": { …parseEpisodeFilename result… }, "lookedUpAt": "…"
}
```

`title` is the TMDB episode name, or `Épisode N` when unknown (season not fetched, or episode missing from
TMDB's season data — the latter still counts as matched and isn't looked up again). `genres` stays empty: episodes never appear
in genre rows.

Scan rules:
- An episode whose previous entry is `matched` is kept as is (unless `force`), like movies.
- Episodes to look up are grouped by `showKey`. For each show: reuse the previous `shows` entry when it is
  matched (unless `force`), otherwise `searchTv` + `tvDetails`. Then, for every season among the episodes to
  look up that the show entry doesn't have yet — or whose cached data lacks one of those episodes (a show
  still airing) — `seasonDetails`. Shows are looked up through the existing
  pool (4 at a time); a show's seasons are fetched one after the other.
- An episode is `matched` when its show is matched and its season details were fetched. If the show matched
  but a season lookup failed, its episodes stay unmatched (`Épisode N`) and are retried next scan.
- A TMDB error on a show keeps the previous entries (or placeholders), counted in `stats.errors`, like movies.
- Shows with no episode file left are dropped from `shows`.
- `stats` gains `shows` (number of shows).

`readMoviesInfos` returns `shows: {}` when the file has none (files written before this change).

### `src/accounts.js` / `src/app.js`

- `GET /api/movies` returns `{ updatedAt, movies, shows }` (`parsed` and `size` still stripped from items).
- `PUT /api/progress/:id`: when the position counts as finished, also sets
  `account.watched[id] = now` (in addition to deleting the progress). The response gains `watched`
  (the date, or `null`).
- `GET /api/watched` → `{ [id]: finishedAt }`, limited to items still in the library (same filtering as
  `/api/progress`).
- `DELETE /api/progress/:id` (restart) doesn't touch `watched`.
- The accounts file comment documents `watched`.

### `public/js/episodes.js` (new, pure, unit-tested)

- `showEpisodes(movies, showKey)` → episodes of a show sorted by season, episode, file.
- `nextEpisode(episodes, current)` → the next episode after `current` (next number in the season, then the
  first of the next season) that isn't being converted, or `null`.
- `showResumeTarget(episodes, progress, watched)` → `{ episode, resume, date }`: the episode with the most
  recent activity (`progress.updatedAt` or `watched` date); in progress → resume it; finished → the next
  episode from the start (or `null` episode when it was the last one); no activity → the first episode.
  `date` is that latest activity (or `null`) and places the show in "Reprendre la lecture" (only when
  `episode` isn't `null`).
- `episodeLabel(episode)` → `S1:É2` / `S1:É1-2`.

### `public/js/app.js`

- Loads `shows` with the movies and `watched` with the progress (and reloads both after a conversion swap).
- Movie rows filter `kind !== 'episode'`.
- "Séries" row: one tile per show that has episodes, poster from the show (fallback: show title), most
  recently added episode first.
- "Reprendre la lecture" mixes started movies and shows by latest activity; a show tile shows the progress
  bar of its in-progress episode, if any.
- Hero: movies and matched shows with a backdrop and overview; Play on a show uses `showResumeTarget`.
- Search: `searchMovies` runs over movies plus shows (shows have `title`, `originalTitle`, `voteAverage`);
  show results render as show tiles.
- Show modal (same modal element, show mode): backdrop, title, meta (★, first air year, number of seasons,
  genres), overview, Play/Resume button labelled with the target (`▶ Reprendre S1:É3`), season `<select>`
  (defaults to the target's season), episode list. Clicking an episode plays it (resuming if it has
  progress). Converting episodes are greyed with their conversion label; failed ones show the error.
- Player title for an episode: `<Show> · S1:É2 · <episode title>`.
- On `ended`, the client saves progress with `position = duration` (instead of only deleting it) so the
  server records the episode/movie as watched, then either starts the next episode (countdown already
  elapsed) or closes the player.

### `public/js/player.js`

- `open(movie, { startAt, title, next })`: `title` overrides the displayed title; `next` is
  `{ label, onPlay }` or `null`.
- When `next` is set and the position enters the credits threshold, an "Épisode suivant" button with a
  10 s countdown appears over the bottom right. Clicking it, or the countdown reaching 0, calls
  `next.onPlay()`; seeking back before the threshold hides it and resets the countdown; the back button /
  Esc closes the player as today. The countdown pauses while the video is paused.
- Watch progress for the finished episode is saved before switching (same `PUT` as `ended`).

### Styling (`public/css/style.css`, `public/index.html`)

Season select and episode list in the modal (still on the left, number + title + runtime, synopsis below,
progress bar under the still), and the "Épisode suivant" button with a filling countdown bar, in the
existing visual style.

## Testing

- `parseEpisodeFilename`: each marker form, multi-episode forms, year hint, release tags after the marker,
  files without marker → `null`, and `parseMovieFilename` cases unchanged.
- `showKey`: case, accents, punctuation.
- `scanMovies` with a fake TMDB client: episodes grouped into one show; one `searchTv`/`tvDetails` per show and
  one `seasonDetails` per season; episode titles filled from season data; unmatched show grouping;
  incremental rescans don't re-query matched episodes; a new season triggers only that season's lookup;
  shows without files are dropped; movies keep their current behaviour.
- API: `/api/movies` returns `shows`; finishing via `PUT /api/progress` records `watched`; `/api/watched`
  filters missing items.
- `episodes.js`: ordering, `nextEpisode` across seasons and skipping converting episodes, `showResumeTarget`
  for in-progress / finished / last-episode / no-activity cases.
- Manual check in the browser: Séries row, show modal, season switch, countdown and auto-play, resume.

## Out of scope

- Folder-based detection (`Show/Season 1/…`), anime absolute numbering, date-based episodes (`2024.03.01`).
- Listing episodes that aren't on disk (missing episodes).
- Manual correction of a wrong show match (rename the file / `npm run scan -- --force`, as for movies).
