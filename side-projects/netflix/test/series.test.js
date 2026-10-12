import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEpisodeFilename, parseMovieFilename, showKey } from '../src/filename.js';

const ep = (showTitle, season, episode, extra = {}) => ({ showTitle, year: null, season, episode, episodeEnd: episode, ...extra });

test('parseEpisodeFilename reads SxxEyy and NxNN markers', () => {
  assert.deepEqual(parseEpisodeFilename('Breaking.Bad.S01E02.1080p.WEB.x264.mkv'), ep('Breaking Bad', 1, 2));
  assert.deepEqual(parseEpisodeFilename('breaking bad s1e2.mp4'), ep('breaking bad', 1, 2));
  assert.deepEqual(parseEpisodeFilename('Show S01 E02.mkv'), ep('Show', 1, 2));
  assert.deepEqual(parseEpisodeFilename('Lupin.2x05.FRENCH.720p.mkv'), ep('Lupin', 2, 5));
  assert.deepEqual(parseEpisodeFilename('Le.Bureau.des.Legendes.S05E10.MULTi.1080p.mkv'), ep('Le Bureau des Legendes', 5, 10));
  assert.deepEqual(parseEpisodeFilename('[Grp] Show - S01E03 [1080p].mkv'), ep('Show', 1, 3));
  assert.deepEqual(parseEpisodeFilename('series/Breaking.Bad.S01E02.mkv'), ep('Breaking Bad', 1, 2), 'folders are ignored');
});

test('parseEpisodeFilename handles multi-episode files', () => {
  assert.deepEqual(parseEpisodeFilename('The.Office.US.S03E01E02.mkv'), ep('The Office US', 3, 1, { episodeEnd: 2 }));
  assert.deepEqual(parseEpisodeFilename('Show.S01E01-E02.mkv'), ep('Show', 1, 1, { episodeEnd: 2 }));
  assert.deepEqual(parseEpisodeFilename('Show.S01E01-02.1080p.mkv'), ep('Show', 1, 1, { episodeEnd: 2 }));
  assert.deepEqual(parseEpisodeFilename('Show.S01E01-1080p.mkv'), ep('Show', 1, 1), 'a resolution is not an episode');
  assert.deepEqual(parseEpisodeFilename('Show.S01E05-02.mkv'), ep('Show', 1, 5), 'a lower end is ignored');
});

test('parseEpisodeFilename uses a year before the marker as a hint', () => {
  assert.deepEqual(parseEpisodeFilename('Doctor.Who.2005.S01E01.mkv'), ep('Doctor Who', 1, 1, { year: 2005 }));
  assert.deepEqual(parseEpisodeFilename('Doctor Who (2005) - S01E01 - Rose.mkv'), ep('Doctor Who', 1, 1, { year: 2005 }));
  assert.deepEqual(parseEpisodeFilename('1923.S01E01.mkv'), ep('1923', 1, 1), 'a year-like show title is kept');
});

test('parseEpisodeFilename leaves movies alone', () => {
  for (const file of [
    'Apollo.13.1995.mkv',
    'Ocean.s.11.2001.mkv',
    'Movie.1920x1080.mkv',
    '2001 A Space Odyssey 1968.mkv',
    'Se7en.1995.mkv',
    'Le.Fabuleux.Destin.d\'Amelie.Poulain.2001.1080p.BluRay.x264.mkv',
    'S01E02.mkv', // no show name: nothing to group it with
  ]) {
    assert.equal(parseEpisodeFilename(file), null, file);
  }
  assert.deepEqual(parseMovieFilename('Intouchables (2011) [MULTI].mp4'), { title: 'Intouchables', year: 2011 });
});

test('showKey ignores case, accents and punctuation', () => {
  assert.equal(showKey('Breaking Bad'), 'breaking bad');
  assert.equal(showKey('breaking  bad'), 'breaking bad');
  assert.equal(showKey('Le Bureau des Légendes'), 'le bureau des legendes');
  assert.equal(showKey('The Office (US)'), 'the office us');
});
