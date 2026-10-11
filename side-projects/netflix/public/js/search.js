// Fuzzy movie search based on the (unrestricted) Damerau-Levenshtein distance.
// Shared by the browser and the Node tests, so no dependencies.

/**
 * True Damerau-Levenshtein distance (Lowrance-Wagner algorithm): insertions,
 * deletions, substitutions and transpositions of adjacent characters, where
 * transposed characters may still be edited afterwards (unlike the simpler
 * "optimal string alignment" variant, "ca" → "abc" is 2, not 3).
 */
export function damerauLevenshtein(a, b) {
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0) return lenB;
  if (lenB === 0) return lenA;

  const maxDist = lenA + lenB;
  const lastRowOf = new Map(); // character → last row (1-based) where it appeared in `a`
  // Matrix with an extra border row/column, flattened. d[i + 1][j + 1] ≡ distance(a[0..i), b[0..j)).
  const width = lenB + 2;
  const d = new Uint32Array((lenA + 2) * width);
  const at = (i, j) => i * width + j;

  d[at(0, 0)] = maxDist;
  for (let i = 0; i <= lenA; i++) {
    d[at(i + 1, 0)] = maxDist;
    d[at(i + 1, 1)] = i;
  }
  for (let j = 0; j <= lenB; j++) {
    d[at(0, j + 1)] = maxDist;
    d[at(1, j + 1)] = j;
  }

  for (let i = 1; i <= lenA; i++) {
    let lastMatchCol = 0;
    for (let j = 1; j <= lenB; j++) {
      const i1 = lastRowOf.get(b[j - 1]) ?? 0;
      const j1 = lastMatchCol;
      let cost = 1;
      if (a[i - 1] === b[j - 1]) {
        cost = 0;
        lastMatchCol = j;
      }
      d[at(i + 1, j + 1)] = Math.min(
        d[at(i, j)] + cost, // substitution
        d[at(i + 1, j)] + 1, // insertion
        d[at(i, j + 1)] + 1, // deletion
        d[at(i1, j1)] + (i - i1 - 1) + 1 + (j - j1 - 1), // transposition
      );
    }
    lastRowOf.set(a[i - 1], i);
  }
  return d[at(lenA + 1, lenB + 1)];
}

/** Lowercase, strip accents and punctuation: "L'Été meurtrier" → "l ete meurtrier". */
export function normalize(text) {
  return (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Number of typos tolerated for a query of this length. */
export function maxTypos(length) {
  if (length <= 2) return 0;
  if (length <= 4) return 1;
  if (length <= 8) return 2;
  return 3;
}

/**
 * Distance between a normalized query and a normalized text. The query is compared
 * with every run of consecutive words of the same word count (and with the prefix of
 * that run, so a query typed halfway still matches), keeping the best score.
 */
export function matchDistance(query, text) {
  if (!query || !text) return Infinity;
  if (text.includes(query)) return 0;

  const queryWords = query.split(' ').length;
  const words = text.split(' ');
  let best = damerauLevenshtein(query, text);
  for (let size = Math.max(1, queryWords - 1); size <= queryWords + 1; size++) {
    for (let start = 0; start + size <= words.length; start++) {
      const window = words.slice(start, start + size).join(' ');
      best = Math.min(
        best,
        damerauLevenshtein(query, window),
        damerauLevenshtein(query, window.slice(0, query.length)),
      );
      if (best === 0) return 0;
    }
  }
  return best;
}

/**
 * Rank movies against a query. Returns the movies that are within the typo budget,
 * best matches first (exact substring, then fewest edits, then rating).
 */
export function searchMovies(movies, rawQuery) {
  const query = normalize(rawQuery);
  if (!query) return [];
  const budget = maxTypos(query.length);

  const scored = [];
  for (const movie of movies) {
    const fields = [movie.title, movie.originalTitle].map(normalize);
    let distance = Infinity;
    let prefix = false;
    for (const field of fields) {
      distance = Math.min(distance, matchDistance(query, field));
      if (field.startsWith(query)) prefix = true;
    }
    if (distance <= budget) scored.push({ movie, distance, prefix });
  }

  scored.sort(
    (x, y) =>
      x.distance - y.distance ||
      Number(y.prefix) - Number(x.prefix) ||
      (y.movie.voteAverage ?? 0) - (x.movie.voteAverage ?? 0),
  );
  return scored.map((s) => s.movie);
}
