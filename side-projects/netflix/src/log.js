// Console logs for humans, one block per event:
//
//   07/11/2026 14:32 | Cast stream refused
//   ------
//   { "reason": "replaced by a newer cast link", … }
//   ------
//
// Pino-style calls work too (`log.info(data, 'Sentence')`, `log.error(err, 'Sentence')`), so the same
// object is Fastify's logger. debug/trace are dropped: Fastify's internals use them.

const pad = (n) => String(n).padStart(2, '0');

export function formatDate(date) {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** An Error as plain JSON, its stack split in lines so it stays readable once indented. */
function errorToJson(err, withStack) {
  const json = { message: err.message };
  if (err.code) json.code = err.code;
  if (err.statusCode) json.statusCode = err.statusCode;
  if (withStack && err.stack) json.stack = err.stack.split('\n').slice(1).map((line) => line.trim());
  return json;
}

function toJson(data, withStack) {
  const seen = new WeakSet();
  return JSON.stringify(
    data,
    (key, value) => {
      if (value instanceof Error) return errorToJson(value, withStack);
      if (typeof value === 'bigint') return String(value);
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[circular]';
        seen.add(value);
      }
      return value;
    },
    2,
  );
}

export function formatLog(sentence, data, { date = new Date(), withStack = false } = {}) {
  const line = `${formatDate(date)} | ${sentence}`;
  const empty = data === undefined || data === null || (typeof data === 'object' && !Array.isArray(data) && !Object.keys(data).length);
  return empty ? line : `${line}\n------\n${toJson(data, withStack)}\n------`;
}

/** (sentence) | (data, sentence) | (err, sentence?) → { sentence, data } */
function readArgs(first, second) {
  if (typeof first === 'string') return { sentence: first, data: second };
  if (first instanceof Error) return { sentence: second ?? first.message, data: { error: first } };
  let data = first;
  if (data && typeof data === 'object') {
    // Fastify passes its request/reply objects: huge, and already described by the request logs.
    const { req, res, reqId, ...rest } = data;
    data = rest;
  }
  return { sentence: second ?? '', data };
}

export function createLogger({ out = (text) => console.log(text), err = (text) => console.error(text), now = () => new Date() } = {}) {
  const emit = (write, withStack) => (first, second) => {
    const { sentence, data } = readArgs(first, second);
    write(formatLog(sentence, data, { date: now(), withStack }));
  };
  const noop = () => {};
  const logger = {
    level: 'info',
    info: emit(out, false),
    warn: emit(err, false),
    error: emit(err, true),
    fatal: emit(err, true),
    debug: noop,
    trace: noop,
    silent: noop,
    child: () => logger,
  };
  return logger;
}

/** The app-wide logger. */
export const log = createLogger();

/** Swallows everything (tests). */
export const silentLog = createLogger({ out() {}, err() {} });
