/* Environment configuration. Secrets come from the environment, never source. */

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');

dotenv.config({ path: path.join(ROOT, '.env') });

const bool = (value, fallback = false) =>
  value === undefined ? fallback : /^(1|true|yes|on)$/i.test(String(value));

/* Vercel sets NODE_ENV itself and refuses to let you set it, so production is
   also recognised from VERCEL_ENV. Without this the app would run a deployed
   instance with development defaults — unsecured cookies, no HTTPS enforcement
   — simply because the variable it looked for could not be provided. */
const environment = process.env.NODE_ENV
  || (process.env.VERCEL_ENV === 'production' ? 'production' : null)
  || (process.env.VERCEL ? 'production' : null)
  || 'development';

export const config = {
  env: environment,
  // Seals the session cookie. Set SESSION_SECRET in every deployed environment:
  // rotating it simply signs everyone out.
  sessionSecret: process.env.SESSION_SECRET || 'diiwaan-development-session-secret-change-me',
  port: Number(process.env.PORT || 4173),
  appUrl: process.env.APP_URL || `http://localhost:${Number(process.env.PORT || 4173)}`,

  /* Firebase is the only identity provider. The project id is all the server
     needs to verify a token — Google publishes the signing keys — and the web
     api key is public by design, handed to the browser to talk to Firebase
     directly. There is no service account and no private key in this project. */
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    appId: process.env.FIREBASE_APP_ID || ''
    /* There was a `googleAuth` flag here, read by nothing, describing an
       architecture this app no longer has — it explained that our own origins
       must be authorised redirect URIs, which stopped being true when the round
       trip moved to Firebase's handler. googleSignInReady() asks Google itself
       and is the only answer anyone reads. */
  },

  mongo: {
    uri: process.env.MONGODB_URI || '',
    database: process.env.MONGODB_DATABASE || 'diiwaan',
    // With no URI, development spins up a real mongod locally via mongodb-memory-server,
    // storing its files under .data so restarts keep the data.
    useMemoryServer: !process.env.MONGODB_URI,
    dataDir: process.env.MONGODB_DATA_DIR || path.join(ROOT, '.data', 'mongo')
  },

  cors: {
    origins: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  },

  push: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:hello@diiwaan.so'
  },

  uploads: {
    // 5 MB, matching the storage bucket. SVG is not accepted: it is served back
    // to customers and can carry script, so the browser rasterises it first.
    maxBytes: Number(process.env.UPLOAD_MAX_BYTES || 5 * 1024 * 1024),
    mimeTypes: ['image/png', 'image/jpeg', 'image/webp']
  },

  seedDemo: bool(process.env.SEED_DEMO_DATA, false)
};

export function assertConfig() {
  const missing = [];
  /* Without these two nobody can sign in at all, in any environment. Naming them
     here means a misconfigured deployment says so on the first request instead
     of looking like a broken password. */
  if (!config.firebase.projectId) missing.push('FIREBASE_PROJECT_ID');
  if (!config.firebase.apiKey) missing.push('FIREBASE_API_KEY');
  if (config.env === 'production') {
    if (process.env.SESSION_SECRET === undefined) missing.push('SESSION_SECRET');
    /* In development an absent URI starts a local mongod; a deployed instance
       has nowhere to put one, so name it here rather than failing later with a
       connection error nobody can act on. */
    if (!config.mongo.uri) missing.push('MONGODB_URI');
  }
  if (missing.length) {
    throw new Error(
      `Missing environment variables: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`
    );
  }
}
