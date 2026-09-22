import Fastify from 'fastify';
import Static from '@fastify/static';
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { MongoClient, type Collection } from 'mongodb';

const MONGO_URL = process.env.MONGO_URL;
if (!MONGO_URL) {
  console.error('MONGO_URL is required.');
  process.exit(1);
}

const QUESTIONS_DIR = path.join(process.cwd(), 'questions');

const questions = readdirSync(QUESTIONS_DIR)
  .filter(e => e.endsWith('.html'))
  .sort()
  .map(e => ({ name: e.slice(0, -'.html'.length), file: path.join(QUESTIONS_DIR, e) }));

const questionNames = new Set(questions.map(q => q.name));

type AnswerDoc = {
  question: string;
  byCountries: { [countryCode: string]: { [answer: string]: number } };
};

const mongo = new MongoClient(MONGO_URL);
console.log(MONGO_URL);
await mongo.connect();
const answers: Collection<AnswerDoc> = mongo.db().collection<AnswerDoc>('answers');
await answers.createIndex({ question: 1 }, { unique: true });

let cache: { [key: string]: string } = {};

const fastify = Fastify({
  logger: true
});

fastify.register(Static, {
  root: path.join(process.cwd(), 'web')
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

fastify.get('/play/:id', (req: Fastify.FastifyRequest<{ Params: { id: string } }>, res) => {
  let questionId = parseInt(req.params.id);
  if (isNaN(questionId) || questionId >= questions.length || questionId < 0) {
    questionId = 0;
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

  const country = await countryOf(req.ip);

  const doc = await answers.findOneAndUpdate(
    { question },
    {
      $inc: { [`byCountries.${country}.${answer}`]: 1 },
      $setOnInsert: { question }
    },
    { upsert: true, returnDocument: 'after', projection: { _id: 0 } }
  );

  return res.send(doc);
});

fastify.listen({ host: "0.0.0.0", port: 3000 }, (err, address) => {
  if (err) throw err
})
