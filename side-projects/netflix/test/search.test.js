import { test } from 'node:test';
import assert from 'node:assert/strict';
import { damerauLevenshtein, matchDistance, normalize, searchMovies } from '../public/js/search.js';

test('damerauLevenshtein basics', () => {
  assert.equal(damerauLevenshtein('', ''), 0);
  assert.equal(damerauLevenshtein('abc', ''), 3);
  assert.equal(damerauLevenshtein('', 'abc'), 3);
  assert.equal(damerauLevenshtein('kitten', 'sitting'), 3);
  assert.equal(damerauLevenshtein('amelie', 'amelie'), 0);
});

test('damerauLevenshtein counts an adjacent transposition as one edit', () => {
  assert.equal(damerauLevenshtein('ab', 'ba'), 1);
  assert.equal(damerauLevenshtein('amleie', 'amelie'), 1);
});

test('damerauLevenshtein is the unrestricted variant, not OSA', () => {
  // OSA gives 3 here; true Damerau-Levenshtein gives 2.
  assert.equal(damerauLevenshtein('ca', 'abc'), 2);
});

test('normalize strips accents, case and punctuation', () => {
  assert.equal(normalize("L'Été Meurtrier!"), 'l ete meurtrier');
});

test('matchDistance finds typos inside longer titles', () => {
  assert.equal(matchDistance('fabuleux', 'le fabuleux destin d amelie poulain'), 0);
  assert.equal(matchDistance('fabuelux', 'le fabuleux destin d amelie poulain'), 1);
  assert.equal(matchDistance('le fabi', 'le fabuleux destin'), 1);
});

const movies = [
  { title: 'Le Fabuleux Destin d’Amélie Poulain', originalTitle: 'Le Fabuleux Destin d’Amélie Poulain', voteAverage: 7.9 },
  { title: 'Intouchables', originalTitle: 'Intouchables', voteAverage: 8.3 },
  { title: 'La Haine', originalTitle: 'La Haine', voteAverage: 8.0 },
  { title: 'Le Seigneur des anneaux : La Communauté de l’anneau', originalTitle: 'The Lord of the Rings: The Fellowship of the Ring', voteAverage: 8.4 },
];

test('searchMovies tolerates typos and accents', () => {
  assert.equal(searchMovies(movies, 'amelei')[0].title, movies[0].title);
  assert.equal(searchMovies(movies, 'intouchable')[0].title, 'Intouchables');
  assert.equal(searchMovies(movies, 'itnouchables')[0].title, 'Intouchables');
});

test('searchMovies also matches original titles', () => {
  assert.equal(searchMovies(movies, 'lord of the rigns')[0].originalTitle, movies[3].originalTitle);
});

test('searchMovies rejects unrelated queries and empty input', () => {
  assert.deepEqual(searchMovies(movies, 'zzzzzz'), []);
  assert.deepEqual(searchMovies(movies, '   '), []);
});
