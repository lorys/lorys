const API_BASE = 'https://api.themoviedb.org/3';
const LANGUAGE = 'fr-FR';

export function createTmdbClient(apiKey, { fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('THEMOVIEDB_API_KEY is not set');
  // v4 "API Read Access Tokens" are JWTs and go in the Authorization header;
  // v3 API keys go in the query string.
  const isBearer = apiKey.startsWith('eyJ');

  async function get(endpoint, params = {}) {
    const url = new URL(API_BASE + endpoint);
    url.searchParams.set('language', LANGUAGE);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    if (!isBearer) url.searchParams.set('api_key', apiKey);
    const headers = { accept: 'application/json' };
    if (isBearer) headers.authorization = `Bearer ${apiKey}`;

    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, { headers });
      if (res.status === 429 && attempt < 5) {
        const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`TMDB ${endpoint} failed: HTTP ${res.status}`);
      return res.json();
    }
  }
  
  function normalizeMovieFilename(name) {
    return name.replaceAll('1080p', '')
                .replaceAll('.', ' ')
                .replaceAll('-', ' ')
                .replaceAll('_', ' ')
                .replaceAll('MULTi', '')
                .replaceAll('VF2', '')
                .replaceAll('mkv', '')
                .replaceAll('H264', '')
                .replaceAll('SUPPLY', '')
                .replaceAll('wawacity', '')
                .replaceAll('FEEDBACK', '')
                .replaceAll('WEBRIP', '')
                .replaceAll('AMZ', '')
                .replaceAll('HDR10', '')
                .replaceAll('x265', '')
                .replaceAll('EAC3', '');
  }

  return {
    async searchMovie(title, year) {
      let data = await get('/search/movie', { query: normalizeMovieFilename(title), year: year ?? undefined, include_adult: false });
      // The year in filenames is sometimes off by one (festival vs release date): retry without it.
      if (!data.results?.length && year) data = await get('/search/movie', { query: normalizeMovieFilename(title), include_adult: false });
      console.log("Search movie", data);
      return data.results?.[0] ?? null;
    },
    movieDetails(id) {
      return get(`/movie/${id}`, { append_to_response: 'credits' });
    },
    async searchTv(title, year) {
      const query = normalizeMovieFilename(title);
      let data = await get('/search/tv', { query, first_air_date_year: year ?? undefined, include_adult: false });
      if (!data.results?.length && year) data = await get('/search/tv', { query, include_adult: false });
      return data.results?.[0] ?? null;
    },
    tvDetails(id) {
      return get(`/tv/${id}`);
    },
    seasonDetails(id, season) {
      return get(`/tv/${id}/season/${season}`);
    },
  };
}
