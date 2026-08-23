/* Environment configuration. Secrets come from the environment, never source. */

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');

dotenv.config({ path: path.join(ROOT, '.env') });

const bool = (value, fallback = false) =>
  value === undefined ? fallback : /^(1|true|yes|on)$/i.test(String(value));

export const config = {
  env: process.env.NODE_ENV || 'development',
  // Seals the session cookie. Set SESSION_SECRET in every deployed environment:
  // rotating it simply signs everyone out.
  sessionSecret: process.env.SESSION_SECRET || 'diiwaan-development-session-secret-change-me',
  port: Number(process.env.PORT || 4173),
  appUrl: process.env.APP_URL || `http://localhost:${Number(process.env.PORT || 4173)}`,

  supabase: {
    url: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    brandingBucket: process.env.SUPABASE_BRANDING_BUCKET || 'branding',
    /* Google sign-in is a Supabase provider, enabled in the Supabase dashboard.
       The browser cannot tell whether it is configured there, so this flag says
       whether to offer the button — offering one that lands on a provider error
       is worse than not offering it. */
    googleAuth: String(process.env.SUPABASE_GOOGLE_AUTH || '').toLowerCase() === 'true'
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
  if (!config.supabase.url) missing.push('SUPABASE_URL');
  if (!config.supabase.anonKey) missing.push('SUPABASE_ANON_KEY');
  if (config.env === 'production' && process.env.SESSION_SECRET === undefined) missing.push('SESSION_SECRET');
  if (missing.length) {
    throw new Error(
      `Missing environment variables: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`
    );
  }
}
