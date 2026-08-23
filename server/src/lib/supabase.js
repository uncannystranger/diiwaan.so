/* Supabase identity.

   Access tokens are verified locally against the project's JWKS when the project
   uses asymmetric signing keys, and otherwise confirmed with GoTrue itself. Both
   paths end at the same place: a verified Supabase user id, which is the only
   identity the rest of the server trusts. */

import { createRemoteJWKSet, jwtVerify, decodeJwt } from 'jose';
import { config } from '../config.js';

const jwks = config.supabase.url
  ? createRemoteJWKSet(new URL(`${config.supabase.url}/auth/v1/.well-known/jwks.json`))
  : null;

const introspectionCache = new Map(); // token -> { user, expiresAt }
// Short enough that a revoked session dies quickly, long enough to spare GoTrue
// a call per request. Bounded so a flood of unique tokens cannot grow it.
const CACHE_MS = 20_000;
const CACHE_MAX = 500;

function pruneCache() {
  const now = Date.now();
  for (const [token, entry] of introspectionCache) {
    if (entry.expiresAt <= now) introspectionCache.delete(token);
  }
  while (introspectionCache.size > CACHE_MAX) {
    introspectionCache.delete(introspectionCache.keys().next().value);
  }
}

async function verifyWithJwks(token) {
  if (!jwks) return null;
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `${config.supabase.url}/auth/v1`
    });
    return payload;
  } catch {
    return null; // HS256 projects and rotated keys fall through to GoTrue
  }
}

async function verifyWithGoTrue(token) {
  pruneCache();
  const cached = introspectionCache.get(token);
  if (cached) return cached.user;

  const response = await fetch(`${config.supabase.url}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: config.supabase.anonKey
    }
  });
  if (!response.ok) return null;

  const user = await response.json();
  introspectionCache.set(token, { user, expiresAt: Date.now() + CACHE_MS });
  return user;
}

/** Returns { id, email, emailVerified } for a valid access token, or null. */
export async function verifyAccessToken(token) {
  if (!token) return null;

  const payload = await verifyWithJwks(token);
  if (payload?.sub) {
    return {
      id: payload.sub,
      email: payload.email || '',
      // The access token does not carry a reliable confirmation flag; the one
      // authority on that is GoTrue, which fetchUser() asks when it matters.
      emailVerified: undefined
    };
  }

  // Reject anything that is not even a well-formed, unexpired JWT before spending a network call.
  try {
    const claims = decodeJwt(token);
    if (claims.exp && claims.exp * 1000 < Date.now()) return null;
  } catch {
    return null;
  }

  const user = await verifyWithGoTrue(token);
  if (!user?.id) return null;
  return {
    id: user.id,
    email: user.email || '',
    emailVerified: Boolean(user.email_confirmed_at || user.confirmed_at)
  };
}

/** Authoritative GoTrue account record — used where confirmation status matters. */
export async function fetchUser(token) {
  const user = await verifyWithGoTrue(token);
  return user?.id ? user : null;
}

/** Service-role calls (admin user lookups, server-side storage writes). */
export async function serviceFetch(path, init = {}) {
  if (!config.supabase.serviceRoleKey) {
    throw Object.assign(new Error('This action needs SUPABASE_SERVICE_ROLE_KEY to be configured.'), { status: 501 });
  }
  return fetch(`${config.supabase.url}${path}`, {
    ...init,
    headers: {
      apikey: config.supabase.serviceRoleKey,
      Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
      ...(init.headers || {})
    }
  });
}

export const storagePublicUrl = objectPath =>
  `${config.supabase.url}/storage/v1/object/public/${config.supabase.brandingBucket}/${objectPath}`;
