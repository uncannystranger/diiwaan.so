/* MongoDB: connection, collection schemas, indexes.

   Collections are created with JSON-Schema validators so malformed documents
   cannot land even if a service misbehaves, and every tenant-scoped collection
   is indexed by businessId because every tenant-scoped query filters on it. */

import { MongoClient } from 'mongodb';
import { config } from './config.js';

let client;
let db;
let memoryServer;

export const collections = {
  profiles: 'user_profiles',
  businesses: 'businesses',
  members: 'business_members',
  queues: 'queues',
  tickets: 'tickets',
  services: 'services',
  invitations: 'invitations',
  events: 'analytics_events',
  audit: 'audit_logs',
  pushSubscriptions: 'push_subscriptions'
};

const objectString = (extra = {}) => ({ bsonType: 'string', ...extra });
// JavaScript has one number type; the driver may send int32, long or double for
// the same value, so numeric fields accept all three.
const number = (extra = {}) => ({ bsonType: ['int', 'long', 'double'], ...extra });

const schemas = {
  [collections.profiles]: {
    bsonType: 'object',
    required: ['supabaseUserId', 'email', 'createdAt'],
    properties: {
      supabaseUserId: objectString(),
      email: objectString(),
      name: objectString(),
      phone: objectString(),
      avatar: objectString(),
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' }
    }
  },
  [collections.businesses]: {
    bsonType: 'object',
    required: ['ownerId', 'name', 'slug', 'createdAt'],
    properties: {
      ownerId: objectString(),
      name: objectString({ minLength: 2, maxLength: 120 }),
      slug: objectString({ pattern: '^[a-z0-9][a-z0-9-]{1,48}$' }),
      category: objectString(),
      description: objectString({ maxLength: 400 }),
      logo: objectString(),
      phone: objectString(),
      email: objectString(),
      address: objectString(),
      city: objectString(),
      country: objectString(),
      timezone: objectString(),
      branding: { bsonType: 'object' },
      customerExperience: { bsonType: 'object' },
      queueSettings: { bsonType: 'object' },
      qrSettings: { bsonType: 'object' },
      onboarded: { bsonType: 'bool' },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' }
    }
  },
  [collections.members]: {
    bsonType: 'object',
    required: ['businessId', 'role', 'status', 'createdAt'],
    properties: {
      businessId: { bsonType: 'objectId' },
      userId: { bsonType: ['string', 'null'] },   // set once the invite is accepted
      email: objectString(),
      name: objectString(),
      role: { enum: ['owner', 'manager', 'staff'] },
      status: { enum: ['active', 'invited', 'disabled'] },
      serviceIds: { bsonType: 'array' },
      lastActiveAt: { bsonType: ['date', 'null'] },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' }
    }
  },
  [collections.queues]: {
    bsonType: 'object',
    required: ['businessId', 'name', 'status', 'createdAt'],
    properties: {
      businessId: { bsonType: 'objectId' },
      name: objectString(),
      prefix: objectString({ pattern: '^[A-Z]$' }),
      status: { enum: ['open', 'paused', 'closed'] },
      avgServiceMin: number(),
      nextNumber: number(),
      servingTicketId: { bsonType: ['objectId', 'null'] },
      openedAt: { bsonType: ['date', 'null'] },
      closedAt: { bsonType: ['date', 'null'] },
      version: number(),
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' }
    }
  },
  [collections.tickets]: {
    bsonType: 'object',
    required: ['businessId', 'queueId', 'number', 'label', 'status', 'createdAt'],
    properties: {
      businessId: { bsonType: 'objectId' },
      queueId: { bsonType: 'objectId' },
      number: number(),
      label: objectString(),
      name: objectString({ maxLength: 80 }),
      /* Sealed at rest, so the stored value is the ciphertext envelope rather
         than the 32 characters a person typed. */
      phone: objectString({ maxLength: 256 }),
      serviceId: { bsonType: ['objectId', 'null'] },
      serviceName: objectString(),
      status: { enum: ['waiting', 'called', 'serving', 'completed', 'skipped', 'cancelled', 'no_show'] },
      position: number(),
      source: { enum: ['public', 'desk'] },
      sessionToken: objectString(),     // lets a customer device re-read only its own ticket
      calledAt: { bsonType: ['date', 'null'] },
      servingAt: { bsonType: ['date', 'null'] },
      completedAt: { bsonType: ['date', 'null'] },
      recallCount: number(),
      servedBy: objectString(),
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' }
    }
  },
  [collections.services]: {
    bsonType: 'object',
    required: ['businessId', 'name', 'createdAt'],
    properties: {
      businessId: { bsonType: 'objectId' },
      name: objectString({ minLength: 1, maxLength: 60 }),
      description: objectString({ maxLength: 200 }),
      estimatedDuration: number(),
      color: objectString(),
      active: { bsonType: 'bool' },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' }
    }
  },
  [collections.invitations]: {
    bsonType: 'object',
    required: ['businessId', 'email', 'role', 'token', 'createdAt'],
    properties: {
      businessId: { bsonType: 'objectId' },
      email: objectString(),
      role: { enum: ['manager', 'staff'] },
      token: objectString(),
      acceptedAt: { bsonType: ['date', 'null'] },
      createdAt: { bsonType: 'date' }
    }
  },
  [collections.events]: {
    bsonType: 'object',
    required: ['businessId', 'type', 'createdAt'],
    properties: {
      businessId: { bsonType: 'objectId' },
      queueId: { bsonType: ['objectId', 'null'] },
      ticketId: { bsonType: ['objectId', 'null'] },
      type: { bsonType: 'string' },
      actorId: objectString(),
      data: { bsonType: 'object' },
      createdAt: { bsonType: 'date' }
    }
  },
  [collections.pushSubscriptions]: {
    bsonType: 'object',
    required: ['businessId', 'ticketId', 'endpoint', 'createdAt'],
    properties: {
      businessId: { bsonType: 'objectId' },
      ticketId: { bsonType: 'objectId' },
      endpoint: objectString(),
      keys: { bsonType: 'object' },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' }
    }
  },
  [collections.audit]: {
    bsonType: 'object',
    required: ['businessId', 'action', 'createdAt'],
    properties: {
      businessId: { bsonType: ['objectId', 'null'] },
      actorId: objectString(),
      action: objectString(),
      target: objectString(),
      ip: objectString(),
      data: { bsonType: 'object' },
      createdAt: { bsonType: 'date' }
    }
  }
};

async function ensureCollection(name) {
  const existing = await db.listCollections({ name }).toArray();
  const validator = { $jsonSchema: schemas[name] };
  if (existing.length === 0) {
    await db.createCollection(name, { validator, validationLevel: 'moderate' });
  } else {
    await db.command({ collMod: name, validator, validationLevel: 'moderate' });
  }
}

/* Index definitions change as the product does. When an existing index has the
   same shape but different options, MongoDB refuses rather than migrating, so
   the old one is dropped and rebuilt — safe here because every index is derived
   from the code below, never hand-made. */
async function ensure(name, specs) {
  const collection = db.collection(name);
  try {
    await collection.createIndexes(specs);
  } catch (error) {
    if (error.code !== 85 && error.code !== 86) throw error;
    for (const spec of specs) {
      try {
        await collection.dropIndex(Object.keys(spec.key).map(k => `${k}_${spec.key[k]}`).join('_'));
      } catch { /* it may not exist under that name */ }
    }
    await collection.createIndexes(specs);
  }
}

async function ensureIndexes() {
  await ensure(collections.profiles, [
    { key: { supabaseUserId: 1 }, unique: true },
    { key: { email: 1 } }
  ]);
  await ensure(collections.businesses, [
    { key: { slug: 1 }, unique: true },
    { key: { ownerId: 1 } },
    { key: { createdAt: -1 } }
  ]);
  await ensure(collections.members, [
    { key: { businessId: 1, userId: 1 }, unique: true, partialFilterExpression: { userId: { $type: 'string' } } },
    { key: { userId: 1, status: 1 } },
    { key: { businessId: 1, status: 1 } },
    { key: { businessId: 1, email: 1 }, unique: true }
  ]);
  await ensure(collections.queues, [
    { key: { businessId: 1 } },
    { key: { businessId: 1, status: 1 } }
  ]);
  await ensure(collections.tickets, [
    { key: { queueId: 1, status: 1, position: 1 } },
    { key: { businessId: 1, status: 1 } },
    { key: { businessId: 1, createdAt: -1 } },
    { key: { queueId: 1, number: 1 }, unique: true },
    { key: { sessionToken: 1 }, unique: true, sparse: true }
  ]);
  await ensure(collections.services, [
    { key: { businessId: 1, active: 1 } },
    { key: { businessId: 1, name: 1 }, unique: true }
  ]);
  await ensure(collections.invitations, [
    { key: { token: 1 }, unique: true },
    { key: { businessId: 1, email: 1 }, unique: true }
  ]);
  await ensure(collections.events, [
    { key: { businessId: 1, createdAt: -1 } },
    { key: { businessId: 1, type: 1, createdAt: -1 } },
    { key: { ticketId: 1 } }
  ]);
  await ensure(collections.pushSubscriptions, [
    { key: { ticketId: 1 }, unique: true },
    { key: { businessId: 1 } },
    // Subscriptions are worthless once the visit is long over.
    { key: { updatedAt: 1 }, expireAfterSeconds: 60 * 60 * 24 * 2 }
  ]);
  await ensure(collections.audit, [
    { key: { businessId: 1, createdAt: -1 } },
    { key: { actorId: 1, createdAt: -1 } }
  ]);
}


/* Development convenience: run one real mongod locally, keep its files on disk
   so restarts do not wipe your work, and publish its URI so other processes —
   the seed script, the API tests — join the same instance instead of fighting
   over the data directory. */
async function localDevelopmentMongo() {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const dbPath = config.mongo.dataDir;
  const uriFile = path.join(dbPath, '..', 'mongo-uri');

  try {
    const existing = (await readFile(uriFile, 'utf8')).trim();
    if (existing) {
      const probe = new MongoClient(existing, { serverSelectionTimeoutMS: 800 });
      await probe.connect();
      await probe.db('admin').command({ ping: 1 });
      await probe.close();
      console.log('[db] joined the MongoDB already running for development');
      return existing;
    }
  } catch {
    /* not running yet — start one below */
  }

  const { MongoMemoryServer } = await import('mongodb-memory-server');
  await mkdir(dbPath, { recursive: true });
  memoryServer = await MongoMemoryServer.create({
    instance: { dbName: config.mongo.database, dbPath, storageEngine: 'wiredTiger' }
  });
  const uri = memoryServer.getUri();
  await writeFile(uriFile, uri, 'utf8');
  console.log(`[db] no MONGODB_URI set — running a local MongoDB from ${dbPath}`);
  return uri;
}

export async function connect() {
  if (db) return db;

  let uri = config.mongo.uri;
  if (!uri && config.mongo.useMemoryServer) uri = await localDevelopmentMongo();

  /* A serverless invocation has seconds, not minutes. The driver's default is to
     keep looking for a reachable server for 30s, which outlives the function and
     leaves the request hanging with nothing in the logs — the least debuggable
     failure there is. Eight seconds is long enough for a cold TLS handshake to a
     distant region and short enough to still return a real error. */
  client = new MongoClient(uri, {
    retryWrites: true,
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000
  });

  try {
    await client.connect();
  } catch (error) {
    /* Almost always one of two things, and the distinction matters: the wrong
       password, or an IP the cluster will not accept. Say which. */
    const message = String(error?.message || error);
    const hint = /authentication failed|bad auth/i.test(message)
      ? 'The database refused the username or password in MONGODB_URI.'
      : 'The database could not be reached. If it is MongoDB Atlas, add 0.0.0.0/0 under Network Access — a serverless host has no fixed IP to allowlist.';
    throw new Error(`${hint} (${message})`);
  }
  db = client.db(config.mongo.database);

  /* Applying validators and indexes is eight round trips to the cluster. On a
     long-running server that cost is paid once at boot; on a serverless host it
     is paid on every cold start, in front of the first person to open the page.
     It is idempotent, so in production it runs behind the request and any
     failure simply retries on the next cold start. */
  const migration = runMigrations();
  if (config.env === 'production') {
    migration.catch(error => console.error('[db] schema migration failed', error));
  } else {
    await migration;
  }

  console.log(`[db] connected to ${config.mongo.database}`);
  return db;
}

async function runMigrations() {
  for (const name of Object.values(collections)) await ensureCollection(name);
  await ensureIndexes();
}

export const getDb = () => {
  if (!db) throw new Error('Database not connected yet');
  return db;
};

export const col = name => getDb().collection(name);

export async function disconnect() {
  await client?.close();
  await memoryServer?.stop();
  client = undefined;
  db = undefined;
  memoryServer = undefined;
}
