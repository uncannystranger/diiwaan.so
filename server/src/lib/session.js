/* Session cookies.

   Supabase issues the tokens; this module decides where they live. The refresh
   token — the only long-lived secret — is sealed with AES-256-GCM and stored in
   an HttpOnly, SameSite cookie that JavaScript cannot read, so an XSS bug cannot
   walk off with a session. The short-lived access token is handed to the tab in
   memory only, and is re-minted from the cookie on every page load. */

import crypto from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from './errors.js';

export const COOKIE_NAME = 'dw_session';
const MAX_AGE_DAYS = 30;

const key = crypto.createHash('sha256').update(config.sessionSecret).digest();

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(part => part.toString('base64url')).join('.');
}

function unseal(sealed) {
  try {
    const [iv, tag, body] = String(sealed).split('.').map(part => Buffer.from(part, 'base64url'));
    if (!iv || !tag || !body) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return null; // tampered, or the secret was rotated
  }
}

export function setSessionCookie(res, refreshToken) {
  res.cookie(COOKIE_NAME, seal(refreshToken), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.env === 'production',
    path: '/api/auth',
    maxAge: MAX_AGE_DAYS * 24 * 3600 * 1000
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/api/auth', httpOnly: true, sameSite: 'lax', secure: config.env === 'production' });
}

export const readSessionCookie = req => {
  const sealed = req.cookies?.[COOKIE_NAME];
  return sealed ? unseal(sealed) : null;
};

/* Refresh tokens rotate, so a token can only be spent once. Two tabs restoring
   at the same moment — or a reload racing a scheduled renewal — would otherwise
   have one of them exchange a token the other already spent, and the session
   would die for no good reason. Recently exchanged tokens are remembered for a
   few seconds and replayed instead. */
const recentExchanges = new Map(); // spent refresh token -> { data, at }
const REPLAY_MS = 15_000;

function rememberExchange(spent, data) {
  recentExchanges.set(spent, { data, at: Date.now() });
  for (const [token, entry] of recentExchanges) {
    if (Date.now() - entry.at > REPLAY_MS) recentExchanges.delete(token);
  }
}

/**
 * Exchanges a refresh token with Supabase for a fresh pair. Supabase rotates the
 * refresh token, so the caller must always write the new one back to the cookie.
 */
const inFlight = new Map(); // refresh token -> promise, so parallel tabs share one exchange

export async function exchangeRefreshToken(refreshToken) {
  const replay = recentExchanges.get(refreshToken);
  if (replay && Date.now() - replay.at < REPLAY_MS) return replay.data;
  if (inFlight.has(refreshToken)) return inFlight.get(refreshToken);

  const pending = performExchange(refreshToken).finally(() => inFlight.delete(refreshToken));
  inFlight.set(refreshToken, pending);
  return pending;
}

async function performExchange(refreshToken) {

  const response = await fetch(`${config.supabase.url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: config.supabase.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken })
  });
  if (!response.ok) throw new HttpError(401, 'Your session has expired — please sign in again.');
  const data = await response.json();
  if (!data.access_token || !data.refresh_token) {
    throw new HttpError(401, 'Your session has expired — please sign in again.');
  }
  rememberExchange(refreshToken, data);
  return data;
}

/* A session cookie is only honoured on requests that carry this header. Browsers
   will not attach a custom header to a cross-site form post or image load, so a
   third-party page cannot ride the cookie. */
export function requireClientHeader(req, res, next) {
  if (req.get('x-diiwaan-client') !== 'web') {
    return next(new HttpError(403, 'Missing client header.'));
  }
  next();
}
