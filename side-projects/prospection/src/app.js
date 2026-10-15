import crypto from 'node:crypto';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ObjectId } from 'mongodb';
import { SESSION_COOKIE, SESSION_TTL_MS, checkPassword, createSessionToken, isValidSessionToken } from './session.js';
import { addressFromMapsUrl } from './maps.js';

const STATUSES = ['a_demarcher', 'en_cours', 'gagne', 'perdu'];
const DATE = { type: ['string', 'null'], pattern: '^(\\d{4}-\\d{2}-\\d{2})?$' };
const ID_PARAMS = {
  type: 'object',
  properties: { id: { type: 'string', pattern: '^[a-f0-9]{24}$' } },
  required: ['id'],
};
const COMMERCIAL_BODY = {
  type: 'object',
  properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
  required: ['name'],
};
const TARGET_FIELDS = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  mapsUrl: { type: 'string', maxLength: 2000 },
  address: { type: 'string', maxLength: 500 },
  commercialId: { type: ['string', 'null'], pattern: '^([a-f0-9]{24})?$' },
  nextDate: DATE,
  status: { type: 'string', enum: STATUSES },
};
const NOTE_BODY = {
  type: 'object',
  properties: {
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    text: { type: 'string', minLength: 1, maxLength: 5000 },
    nextDate: DATE,
  },
  required: ['date', 'text'],
};

// Tentatives de connexion par IP : 10 essais par quart d'heure.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

export function buildApp(config, db, { logger = true, resolveAddress = addressFromMapsUrl } = {}) {
  const app = Fastify({ logger, trustProxy: true });
  const secret = crypto.createHash('sha256').update(`prospection:${config.password}`).digest();
  const commercials = db.collection('commercials');
  const targets = db.collection('targets');
  const loginAttempts = new Map();

  app.register(fastifyCookie);
  app.register(fastifyStatic, { root: path.join(import.meta.dirname, '..', 'public') });

  app.setErrorHandler((err, request, reply) => {
    if (err.validation) return reply.code(400).send({ error: 'Données invalides.' });
    request.log.error(err);
    return reply.code(err.statusCode ?? 500).send({ error: 'Erreur serveur.' });
  });

  app.post('/api/login', {
    schema: { body: { type: 'object', properties: { password: { type: 'string' } }, required: ['password'] } },
  }, async (request, reply) => {
    const now = Date.now();
    const entry = loginAttempts.get(request.ip);
    const attempts = entry && entry.until > now ? entry : { count: 0, until: now + LOGIN_WINDOW_MS };
    if (attempts.count >= LOGIN_MAX_ATTEMPTS) {
      return reply.code(429).send({ error: 'Trop de tentatives, réessayez plus tard.' });
    }
    if (!checkPassword(request.body.password, config.password)) {
      attempts.count++;
      loginAttempts.set(request.ip, attempts);
      return reply.code(401).send({ error: 'Mot de passe incorrect.' });
    }
    loginAttempts.delete(request.ip);
    reply.setCookie(SESSION_COOKIE, createSessionToken(secret, now), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      maxAge: SESSION_TTL_MS / 1000,
    });
    return { ok: true };
  });

  app.post('/api/logout', async (request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // Toutes les autres routes /api exigent une session valide.
  app.register(async (api) => {
    api.addHook('onRequest', async (request, reply) => {
      if (!isValidSessionToken(request.cookies[SESSION_COOKIE], secret)) {
        return reply.code(401).send({ error: 'Non connecté.' });
      }
    });

    api.get('/me', async () => ({ ok: true }));

    // --- Commerciaux ---

    api.get('/commercials', async () => {
      const list = await commercials.find().sort({ createdAt: 1 }).toArray();
      return list.map(serialize);
    });

    api.post('/commercials', { schema: { body: COMMERCIAL_BODY } }, async (request, reply) => {
      const doc = { name: request.body.name.trim(), createdAt: new Date() };
      if (!doc.name) return reply.code(400).send({ error: 'Le nom est obligatoire.' });
      const { insertedId } = await commercials.insertOne(doc);
      return reply.code(201).send(serialize({ _id: insertedId, ...doc }));
    });

    api.patch('/commercials/:id', { schema: { params: ID_PARAMS, body: COMMERCIAL_BODY } }, async (request, reply) => {
      const name = request.body.name.trim();
      if (!name) return reply.code(400).send({ error: 'Le nom est obligatoire.' });
      const doc = await commercials.findOneAndUpdate(
        { _id: new ObjectId(request.params.id) },
        { $set: { name } },
        { returnDocument: 'after' },
      );
      if (!doc) return reply.code(404).send({ error: 'Commercial introuvable.' });
      return serialize(doc);
    });

    api.delete('/commercials/:id', { schema: { params: ID_PARAMS } }, async (request, reply) => {
      const _id = new ObjectId(request.params.id);
      const { deletedCount } = await commercials.deleteOne({ _id });
      if (!deletedCount) return reply.code(404).send({ error: 'Commercial introuvable.' });
      // Ses cibles restent, sans commercial assigné.
      await targets.updateMany({ commercialId: _id }, { $set: { commercialId: null } });
      return { ok: true };
    });

    // --- Cibles ---

    api.get('/targets', async () => {
      const list = await targets.find().sort({ createdAt: -1 }).toArray();
      return list.map(serializeTarget);
    });

    api.post('/targets', {
      schema: { body: { type: 'object', properties: TARGET_FIELDS, required: ['name'] } },
    }, async (request, reply) => {
      const fields = await targetFields(request.body);
      if (fields.error) return reply.code(400).send({ error: fields.error });
      const doc = {
        name: '',
        mapsUrl: '',
        address: '',
        commercialId: null,
        nextDate: null,
        status: 'a_demarcher',
        ...fields,
        notes: [],
        createdAt: new Date(),
      };
      // Date à laquelle la cible a quitté « À démarcher » (statistiques).
      doc.startedAt = doc.status === 'a_demarcher' ? null : doc.createdAt;
      const { insertedId } = await targets.insertOne(doc);
      return reply.code(201).send(serializeTarget({ _id: insertedId, ...doc }));
    });

    api.patch('/targets/:id', {
      schema: { params: ID_PARAMS, body: { type: 'object', properties: TARGET_FIELDS } },
    }, async (request, reply) => {
      const fields = await targetFields(request.body);
      if (fields.error) return reply.code(400).send({ error: fields.error });
      const doc = await targets.findOneAndUpdate(
        { _id: new ObjectId(request.params.id) },
        { $set: fields },
        { returnDocument: 'after' },
      );
      if (!doc) return reply.code(404).send({ error: 'Cible introuvable.' });
      if (doc.status !== 'a_demarcher' && !doc.startedAt) {
        doc.startedAt = new Date();
        await targets.updateOne({ _id: doc._id }, { $set: { startedAt: doc.startedAt } });
      }
      return serializeTarget(doc);
    });

    api.delete('/targets/:id', { schema: { params: ID_PARAMS } }, async (request, reply) => {
      const { deletedCount } = await targets.deleteOne({ _id: new ObjectId(request.params.id) });
      if (!deletedCount) return reply.code(404).send({ error: 'Cible introuvable.' });
      return { ok: true };
    });

    // --- Historique (notes datées) ---

    api.post('/targets/:id/notes', { schema: { params: ID_PARAMS, body: NOTE_BODY } }, async (request, reply) => {
      const { date, text, nextDate } = request.body;
      const note = { _id: new ObjectId(), date, text: text.trim(), createdAt: new Date() };
      const update = { $push: { notes: note } };
      if (nextDate !== undefined) update.$set = { nextDate: nextDate || null };
      const _id = new ObjectId(request.params.id);
      const { matchedCount } = await targets.updateOne({ _id }, update);
      if (!matchedCount) return reply.code(404).send({ error: 'Cible introuvable.' });
      // Premier échange noté : la cible passe « en cours ».
      await targets.updateOne({ _id, status: 'a_demarcher' }, { $set: { status: 'en_cours', startedAt: new Date() } });
      return reply.code(201).send(serializeTarget(await targets.findOne({ _id })));
    });

    api.delete('/targets/:id/notes/:noteId', {
      schema: {
        params: {
          type: 'object',
          properties: { ...ID_PARAMS.properties, noteId: ID_PARAMS.properties.id },
          required: ['id', 'noteId'],
        },
      },
    }, async (request, reply) => {
      const doc = await targets.findOneAndUpdate(
        { _id: new ObjectId(request.params.id) },
        { $pull: { notes: { _id: new ObjectId(request.params.noteId) } } },
        { returnDocument: 'after' },
      );
      if (!doc) return reply.code(404).send({ error: 'Cible introuvable.' });
      return serializeTarget(doc);
    });
  }, { prefix: '/api' });

  // Normalise les champs d'une cible ; complète l'adresse depuis le lien Maps si elle est vide.
  async function targetFields(body) {
    const fields = {};
    if (body.name !== undefined) {
      fields.name = body.name.trim();
      if (!fields.name) return { error: 'Le nom du commerce est obligatoire.' };
    }
    if (body.mapsUrl !== undefined) fields.mapsUrl = body.mapsUrl.trim();
    if (body.address !== undefined) fields.address = body.address.trim();
    if (body.status !== undefined) fields.status = body.status;
    if (body.nextDate !== undefined) fields.nextDate = body.nextDate || null;
    if (body.commercialId !== undefined) {
      fields.commercialId = body.commercialId ? new ObjectId(body.commercialId) : null;
      if (fields.commercialId && !(await commercials.countDocuments({ _id: fields.commercialId }))) {
        return { error: 'Commercial introuvable.' };
      }
    }
    if (fields.mapsUrl && !fields.address) {
      fields.address = (await resolveAddress(fields.mapsUrl)) ?? '';
    }
    return fields;
  }

  return app;
}

function serialize({ _id, ...rest }) {
  return { id: _id.toHexString(), ...rest };
}

function serializeTarget(doc) {
  const target = serialize(doc);
  target.commercialId = doc.commercialId ? doc.commercialId.toHexString() : null;
  target.notes = (doc.notes ?? [])
    .map(serialize)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  return target;
}
