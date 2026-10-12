import { test } from 'node:test';
import assert from 'node:assert/strict';
import { episodeLabel, nextEpisode, showEpisodes, showResumeTarget } from '../public/js/episodes.js';

const ep = (id, season, episode, extra = {}) => ({
  id,
  file: `${id}.mkv`,
  kind: 'episode',
  showKey: 'bb',
  season,
  episode,
  episodeEnd: episode,
  ...extra,
});

const library = [
  ep('s2e1', 2, 1),
  ep('s1e2', 1, 2),
  ep('s1e1', 1, 1),
  ep('s1e2-720', 1, 2, { file: 'a-720p.mkv' }), // same episode, another file
  ep('s1e3', 1, 3),
  ep('other', 1, 1, { showKey: 'lupin' }),
  { id: 'film', file: 'Film.mp4', title: 'Film' },
];

test('showEpisodes keeps the show and sorts by season, episode, file', () => {
  assert.deepEqual(showEpisodes(library, 'bb').map((e) => e.id), ['s1e1', 's1e2-720', 's1e2', 's1e3', 's2e1']);
});

test('nextEpisode moves on through seasons, skipping duplicates and conversions', () => {
  const episodes = showEpisodes(library, 'bb');
  const byId = (id) => episodes.find((e) => e.id === id);
  assert.equal(nextEpisode(episodes, byId('s1e1')).id, 's1e2-720');
  assert.equal(nextEpisode(episodes, byId('s1e2-720')).id, 's1e3', 'the other copy of É2 is skipped');
  assert.equal(nextEpisode(episodes, byId('s1e3')).id, 's2e1');
  assert.equal(nextEpisode(episodes, byId('s2e1')), null);

  const converting = episodes.map((e) => (e.id === 's1e3' ? { ...e, conversion: { status: 'converting' } } : e));
  assert.equal(nextEpisode(converting, converting.find((e) => e.id === 's1e2')).id, 's2e1');

  const double = [ep('a', 1, 1, { episodeEnd: 2 }), ep('b', 1, 2), ep('c', 1, 3)];
  assert.equal(nextEpisode(double, double[0]).id, 'c', 'a double episode skips the episode it contains');
});

test('showResumeTarget picks what to play from the latest activity', () => {
  const episodes = showEpisodes(library, 'bb');

  assert.deepEqual(showResumeTarget(episodes, {}, {}), { episode: episodes[0], resume: false, date: null });

  const inProgress = showResumeTarget(episodes, { s1e3: { updatedAt: '2026-10-02T00:00:00Z' } }, { s1e2: '2026-10-01T00:00:00Z' });
  assert.equal(inProgress.episode.id, 's1e3');
  assert.equal(inProgress.resume, true);
  assert.equal(inProgress.date, '2026-10-02T00:00:00Z');

  const finished = showResumeTarget(episodes, { s1e1: { updatedAt: '2026-10-01T00:00:00Z' } }, { s1e3: '2026-10-03T00:00:00Z' });
  assert.equal(finished.episode.id, 's2e1');
  assert.equal(finished.resume, false);
  assert.equal(finished.date, '2026-10-03T00:00:00Z');

  // Last available episode finished: nothing left to resume.
  assert.deepEqual(showResumeTarget(episodes, {}, { s2e1: '2026-10-04T00:00:00Z' }), {
    episode: null,
    resume: false,
    date: '2026-10-04T00:00:00Z',
  });
});

test('episodeLabel', () => {
  assert.equal(episodeLabel(ep('x', 1, 2)), 'S1:É2');
  assert.equal(episodeLabel(ep('x', 3, 1, { episodeEnd: 2 })), 'S3:É1-2');
});
