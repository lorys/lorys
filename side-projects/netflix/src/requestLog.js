// What the request log says about each request: a short sentence and the details worth reading.
import path from 'node:path';

// "METHOD /route" → [sentence when it worked, sentence when it was refused or failed].
const SENTENCES = {
  'POST /api/login': ['User logged in', 'Login refused'],
  'POST /api/logout': ['User logged out', 'Logout failed'],
  'GET /api/me': ['Current user checked', 'Current user check refused'],
  'GET /api/movies': ['Library sent', 'Library refused'],
  'GET /api/conversions': ['Conversions list sent', 'Conversions list refused'],
  'GET /api/disk': ['Disk usage sent', 'Disk usage refused'],
  'GET /api/watching': ['Who is watching sent', 'Who is watching refused'],
  'GET /api/progress': ['Watch progress sent', 'Watch progress refused'],
  'GET /api/watched': ['Watched list sent', 'Watched list refused'],
  'PUT /api/progress/:id': ['Watch progress saved', 'Watch progress not saved'],
  'DELETE /api/progress/:id': ['Watch progress removed', 'Watch progress not removed'],
  'GET /api/downloads': ['Downloads list sent', 'Downloads list refused'],
  'POST /api/downloads': ['Download started', 'Download refused'],
  'DELETE /api/downloads/:id': ['Download removed', 'Download removal refused'],
  'POST /api/add-movie': ['Movie search done', 'Movie search failed'],
  'POST /api/add-movie/:token/download': ['Movie download started', 'Movie download failed'],
  'POST /api/add-serie': ['Series search done', 'Series search failed'],
  'POST /api/add-serie/:token/download': ['Season download started', 'Season download failed'],
  'GET /api/movies/:id/subtitles': ['Subtitles list sent', 'Subtitles list refused'],
  'GET /api/movies/:id/subtitles/:track': ['Subtitles sent', 'Subtitles refused'],
  'GET /api/movies/:id/comments': ['Movie comments sent', 'Movie comments refused'],
  'POST /api/movies/:id/comments': ['Movie comment posted', 'Movie comment refused'],
  'GET /api/shows/:key/comments': ['Show comments sent', 'Show comments refused'],
  'POST /api/shows/:key/comments': ['Show comment posted', 'Show comment refused'],
  'POST /api/movies/:id/match': ['Movie matched again on TMDB', 'Movie TMDB match failed'],
  'POST /api/shows/:key/match': ['Show matched again on TMDB', 'Show TMDB match failed'],
  'DELETE /api/movies/:id': ['Movie deleted', 'Movie deletion refused'],
  'DELETE /api/shows/:key': ['Show deleted', 'Show deletion refused'],
  'POST /api/movies/:id/cast': ['Cast link created', 'Cast link refused'],
  'GET /api/movies/:id/stream': ['Video sent to the browser', 'Video refused to the browser'],
  'GET /': ['Page served', 'Page not served'],
  'GET /*': ['File served', 'File not found'],
  'HEAD /api/movies/:id/stream': ['Video checked by the browser', 'Video check refused'],
};
const CAST_STREAM = ['Video sent through a cast link', 'Cast stream refused'];
const CAST_STREAM_CHECK = ['Video checked through a cast link', 'Cast stream check refused'];
const UNKNOWN = ['Request handled', 'Unknown address requested'];

// Body fields shown in the log, by route. Never the password.
const BODY_FIELDS = {
  'POST /api/login': ['username'],
  'POST /api/downloads': ['url'],
  'PUT /api/progress/:id': ['position', 'duration'],
  'POST /api/add-movie': ['name'],
  'POST /api/add-serie': ['name', 'season', 'type'],
  'POST /api/movies/:id/comments': ['text'],
  'POST /api/shows/:key/comments': ['text'],
  'POST /api/movies/:id/match': ['name'],
  'POST /api/shows/:key/match': ['name'],
};

// Routes where knowing the device (user agent) matters: who logs in, who reads the video.
const WITH_DEVICE = new Set(['POST /api/login', 'GET /api/movies/:id/stream', 'HEAD /api/movies/:id/stream', 'POST /api/movies/:id/cast']);

/** `{ sentence, data }` describing a finished request. `findMovie(id)` resolves a movie id to its entry. */
export async function requestLogDetails(request, reply, { findMovie }) {
  const route = `${request.method} ${request.routeOptions?.url ?? ''}`;
  const status = reply.statusCode;
  const refused = status >= 400;
  const viaCastLink = request.query?.cast !== undefined;

  let sentences = SENTENCES[route] ?? SENTENCES[route.replace(/^HEAD /, 'GET ')] ?? UNKNOWN;
  if (viaCastLink && route.endsWith('/stream')) sentences = request.method === 'HEAD' ? CAST_STREAM_CHECK : CAST_STREAM;
  let sentence = sentences[refused ? 1 : 0];
  // The client hung up before the end: normal for videos (seeking, full buffer), worth knowing elsewhere.
  if (!reply.raw.writableFinished) sentence += ' (interrupted by the client)';

  const data = {
    user: request.user ?? request.session?.username ?? null,
    request: `${request.method} ${request.url.replace(/([?&]cast=)[^&]+/, '$1…')}`,
    status,
    durationMs: Math.round(reply.elapsedTime),
    ip: request.ip,
  };

  const id = request.params?.id;
  if (id && route.includes('/api/movies/:id')) {
    const movie = await findMovie(id).catch(() => null);
    data.movie = movie ? path.basename(movie.file) : id;
  }
  if (request.params?.key) data.show = request.params.key;

  for (const field of BODY_FIELDS[route] ?? []) {
    if (request.body?.[field] !== undefined) data[field] = request.body[field];
  }
  if (request.headers.range) data.range = request.headers.range;
  if (WITH_DEVICE.has(route)) data.device = request.headers['user-agent'] ?? null;
  if (request.castRefused) data.castRefused = request.castRefused;
  if (request.failure) data.error = request.failure;
  return { sentence, data };
}
