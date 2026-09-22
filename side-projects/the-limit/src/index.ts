import Fastify from 'fastify';
import Static from '@fastify/static';
import Cookie from '@fastify/cookie';
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { MongoClient, type Collection } from 'mongodb';

const MONGO_URL = process.env.MONGO_URL;
if (!MONGO_URL) {
  console.error('MONGO_URL is required.');
  process.exit(1);
}

const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY;
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;
const COOKIE_SECRET = process.env.COOKIE_SECRET;
if (!TURNSTILE_SITE_KEY || !TURNSTILE_SECRET_KEY || !COOKIE_SECRET) {
  console.error('TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY and COOKIE_SECRET are required.');
  process.exit(1);
}

const QUESTIONS_DIR = path.join(process.cwd(), 'questions');

const questions = readdirSync(QUESTIONS_DIR)
  .filter(e => e.endsWith('.html'))
  .sort()
  .map(e => ({ name: e.slice(0, -'.html'.length), file: path.join(QUESTIONS_DIR, e) }));

const questionNames = new Set(questions.map(q => q.name));

const VIEWS_DIR = path.join(process.cwd(), 'views');
const indexView = readFileSync(path.join(VIEWS_DIR, 'index.html')).toString()
  .replace('__TURNSTILE_SITE_KEY__', TURNSTILE_SITE_KEY);
const suggestView = readFileSync(path.join(VIEWS_DIR, 'suggest.html')).toString();

type AnswerDoc = {
  question: string;
  byCountries: { [countryCode: string]: { [answer: string]: number } };
};

type SuggestionDoc = {
  text: string;
  country: string;
  createdAt: Date;
};

const mongo = new MongoClient(MONGO_URL);
await mongo.connect();
const answers: Collection<AnswerDoc> = mongo.db().collection<AnswerDoc>('answers');
await answers.createIndex({ question: 1 }, { unique: true });
const suggestions: Collection<SuggestionDoc> = mongo.db().collection<SuggestionDoc>('suggestions');

let cache: { [key: string]: string } = {};

const fastify = Fastify({
  logger: true
});

fastify.register(Cookie, { secret: COOKIE_SECRET });

fastify.register(Static, {
  root: path.join(process.cwd(), 'web'),
  index: false
});

/** Set once the visitor passed the Turnstile check on the main screen. */
const HUMAN_COOKIE = 'human';
const HUMAN_MAX_AGE = 60 * 60 * 24; // seconds

/** Names of the questions already answered, comma separated. */
const ANSWERED_COOKIE = 'answered';
const ANSWERED_MAX_AGE = 60 * 60 * 24 * 365; // seconds

const isHuman = (req: Fastify.FastifyRequest) => {
  const raw = req.cookies[HUMAN_COOKIE];
  if (!raw) return false;
  const { valid, value } = req.unsignCookie(raw);
  return valid && value === '1';
};

const answeredOf = (req: Fastify.FastifyRequest) =>
  new Set((req.cookies[ANSWERED_COOKIE] || '').split(',').filter(n => questionNames.has(n)));

/** Everything that plays the game needs a solved captcha first. */
fastify.addHook('onRequest', async (req, res) => {
  const url = req.url.split('?')[0];
  const isPage = url === '/play' || url.startsWith('/play/');
  const isApi = url === '/answer' || url === '/suggest';
  if (!isPage && !isApi) return;
  if (isHuman(req)) return;

  if (isPage) return res.redirect('/');
  return res.status(403).send({ error: 'captcha required' });
});

fastify.get('/', (req, res) => {
  return res.type('text/html').send(indexView.replace(/__VERIFIED__/g, String(isHuman(req))));
});

fastify.post('/verify', async (req: Fastify.FastifyRequest<{ Body: { token?: string } }>, res) => {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const token = body?.token;
  if (typeof token !== 'string' || !token || token.length > 2048) {
    return res.status(400).send({ error: 'invalid token' });
  }

  const form = new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: token });
  const ip = req.headers['cf-connecting-ip'];
  if (typeof ip === 'string') form.set('remoteip', ip);

  try {
    const verify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(5000)
    });
    const result = await verify.json() as { success?: boolean };
    if (!result.success) return res.status(403).send({ error: 'captcha failed' });
  } catch {
    return res.status(502).send({ error: 'captcha unavailable' });
  }

  return res
    .setCookie(HUMAN_COOKIE, '1', {
      path: '/',
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: HUMAN_MAX_AGE
    })
    .send({ ok: true });
});

/**
 * api.country.is is rate limited (~10 req/s), so we keep every resolved ip
 * around for the lifetime of the process instead of asking twice.
 */
const countryCache = new Map<string, string>();

const isLocalAddress = (ip: string) =>
  ip === '::1' ||
  ip === '127.0.0.1' ||
  ip.startsWith('10.') ||
  ip.startsWith('192.168.') ||
  ip.startsWith('::ffff:127.') ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

const countryOf = async (ip: string): Promise<string> => {
  if (!ip || isLocalAddress(ip)) return 'XX';

  const cached = countryCache.get(ip);
  if (cached) return cached;

  try {
    const res = await fetch(`https://api.country.is/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(2000)
    });
    if (!res.ok) return 'XX';
    const body = await res.json() as { country?: string };
    const country = typeof body.country === 'string' && /^[A-Z]{2}$/.test(body.country) ? body.country : 'XX';
    countryCache.set(ip, country);
    return country;
  } catch {
    return 'XX';
  }
};

/** Mongo forbids "." and "$" in field names, and answers become field names. */
const answerKey = (value: unknown): string | null => {
  const key = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!key || key.length > 64 || /[.$\0]/.test(key)) return null;
  return key;
};

fastify.get('/play/done', (req, res) => {
  return res.type('text/html').send(suggestView);
});

fastify.get('/play/:id', (req: Fastify.FastifyRequest<{ Params: { id: string } }>, res) => {
  let questionId = parseInt(req.params.id);
  if (isNaN(questionId) || questionId >= questions.length || questionId < 0) {
    questionId = 0;
  }

  /* Never ask twice: jump to the next unanswered question, wrapping around. */
  const answered = answeredOf(req);
  if (answered.has(questions[questionId].name)) {
    const offset = questions.findIndex((_, i) =>
      !answered.has(questions[(questionId + i) % questions.length].name));
    if (offset === -1) return res.redirect('/play/done');
    return res.redirect(`/play/${(questionId + offset) % questions.length}`);
  }

  const question = questions[questionId];

  // if (!cache[question.file])
    cache[question.file] = readFileSync(question.file).toString().replace(
      '</head>',
      `<script>window.__QUESTION__=${JSON.stringify({
        name: question.name,
        index: questionId,
        total: questions.length
      })};</script>\n<script src="/results.js"></script>\n</head>`
    );

  return res.type("text/html").send(cache[question.file]);
});

fastify.post('/answer', async (req: Fastify.FastifyRequest<{ Body: { question?: string; answer?: string | number } }>, res) => {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

  const question = body?.question;
  if (typeof question !== 'string' || !questionNames.has(question)) {
    return res.status(400).send({ error: 'unknown question' });
  }

  const answer = answerKey(body?.answer);
  if (!answer) {
    return res.status(400).send({ error: 'invalid answer' });
  }

  const answered = answeredOf(req);
  if (answered.has(question)) {
    return res.status(409).send({ error: 'already answered' });
  }
  answered.add(question);

  const country = await countryOf(req.headers['cf-connecting-ip'] as string);

  const doc = await answers.findOneAndUpdate(
    { question },
    {
      $inc: { [`byCountries.${country}.${answer}`]: 1 },
      $setOnInsert: { question }
    },
    { upsert: true, returnDocument: 'after', projection: { _id: 0 } }
  );

  return res
    .setCookie(ANSWERED_COOKIE, [...answered].join(','), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: ANSWERED_MAX_AGE
    })
    .send(doc);
});

fastify.post('/suggest', async (req: Fastify.FastifyRequest<{ Body: { text?: string } }>, res) => {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 500) {
    return res.status(400).send({ error: 'invalid suggestion' });
  }

  const country = await countryOf(req.headers['cf-connecting-ip'] as string);
  await suggestions.insertOne({ text, country, createdAt: new Date() });

  return res.send({ ok: true });
});

fastify.listen({ host: "0.0.0.0", port: 3000 }, (err, address) => {
  if (err) throw err
})
