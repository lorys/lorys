// Episodes of TV shows: watching order, next episode and where to resume a show.
// Pure functions (no DOM) so they can be unit-tested with node --test.

const isConverting = (item) => ['queued', 'converting'].includes(item.conversion?.status);

/** Episodes of a show, in watching order. */
export function showEpisodes(movies, showKey) {
  return movies
    .filter((m) => m.kind === 'episode' && m.showKey === showKey)
    .sort((a, b) => a.season - b.season || a.episode - b.episode || a.file.localeCompare(b.file));
}

/**
 * The episode to play after `current`: a later episode of the same season (past every episode a
 * multi-episode file contains, and past other copies of it), then the next season. Episodes being
 * converted can't be played and are skipped.
 */
export function nextEpisode(episodes, current) {
  const after = episodes.slice(episodes.findIndex((e) => e.id === current.id) + 1);
  return (
    after.find(
      (e) => !isConverting(e) && (e.season > current.season || (e.season === current.season && e.episode > current.episodeEnd)),
    ) ?? null
  );
}

/**
 * Where "Lecture" takes a show: the episode with the latest activity if it's in progress, the one after
 * it if it was finished (null after the last one), the first episode if nothing was watched yet.
 * `date` is that latest activity, used to sort "Reprendre la lecture".
 */
export function showResumeTarget(episodes, progress, watched) {
  let last = null;
  for (const episode of episodes) {
    const started = progress[episode.id]?.updatedAt;
    const finished = watched[episode.id];
    if (started && (!last || started > last.date)) last = { episode, date: started, finished: false };
    if (finished && (!last || finished > last.date)) last = { episode, date: finished, finished: true };
  }
  if (!last) return { episode: episodes[0] ?? null, resume: false, date: null };
  if (!last.finished) return { episode: last.episode, resume: true, date: last.date };
  return { episode: nextEpisode(episodes, last.episode), resume: false, date: last.date };
}

/** "S1:É2", or "S1:É1-2" for a file holding two episodes. */
export function episodeLabel(episode) {
  const range = episode.episodeEnd > episode.episode ? `${episode.episode}-${episode.episodeEnd}` : String(episode.episode);
  return `S${episode.season}:É${range}`;
}
