/* Session cookies.

   Firebase issues the tokens; this module decides where they live. The refresh
   token — the only long-lived secret — is sealed with AES-256-GCM and stored in
   an HttpOnly, SameSite cookie that JavaScript cannot read, so an XSS bug cannot
   walk off with a session. The short-lived access token is handed to the tab in
   memory only, and is re-minted from the cookie on every page load. */

import crypto from 'node:crypto';
import { decodeJwt } from 'jose';
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
  res.cookie(COOKIE_NAME, seal(`firebase:${refreshToken}`), {
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

/* Cookies minted before Firebase held a token no endpoint here can spend any
   more. They read as null, which signs that tab out cleanly instead of failing
   on an exchange nobody can explain. */
export const readSessionCookie = req => {
  const sealed = req.cookies?.[COOKIE_NAME];
  const value = sealed ? unseal(sealed) : null;
  const match = value && /^firebase:(.+)$/s.exec(value);
  return match ? match[1] : null;
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

/** Exchanges a refresh token for a fresh id token, once per token per moment. */
const inFlight = new Map(); // refresh token -> promise, so parallel tabs share one exchange

export async function exchangeRefreshToken(refreshToken) {
  const replay = recentExchanges.get(refreshToken);
  if (replay && Date.now() - replay.at < REPLAY_MS) return replay.data;
  if (inFlight.has(refreshToken)) return inFlight.get(refreshToken);

  const pending = performExchange(refreshToken).finally(() => inFlight.delete(refreshToken));
  inFlight.set(refreshToken, pending);
  return pending;
}

const claimedEmail = token => {
  try { return decodeJwt(token).email || ''; } catch { return ''; }
};

/* Firebase's token endpoint takes form encoding and answers in snake_case of a
   different shape. Unlike GoTrue it does not rotate the refresh token — the same
   one comes back — but the cookie is rewritten regardless so its expiry slides
   forward and an active owner is never signed out mid-shift. */
/* The refusals that actually mean "this session is over".
 *
 * Everything else Google can answer with — a rate limit, a bad minute in one of
 * its regions, a socket that never opened — means "ask me again", and the two
 * were being treated identically. Any non-OK response became a 401, the caller
 * deleted the cookie, and a thirty-day session that was perfectly valid was
 * destroyed by a hiccup. The person was signed out for real, and the next
 * refresh put them on the landing page with nothing to say why.
 *
 * Google names the definitive ones in the body. Only these end a session. */
const SESSION_IS_OVER = /TOKEN_EXPIRED|INVALID_REFRESH_TOKEN|USER_DISABLED|USER_NOT_FOUND|INVALID_GRANT_TYPE|MISSING_REFRESH_TOKEN|CREDENTIAL_MISMATCH/i;

/** Thrown when we could not find out — the cookie must survive this. */
export class SessionUnknownError extends HttpError {
  constructor(detail) {
    super(503, 'We could not reach the sign-in service. Please try again.');
    this.transient = true;
    this.detail = detail;
  }
}

async function performExchange(refreshToken) {
  let response;
  try {
    response = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${config.firebase.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
        signal: AbortSignal.timeout(8000)
      }
    );
  } catch (error) {
    // Never reached Google at all. That says nothing about the session.
    throw new SessionUnknownError(error?.name || 'network');
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const reason = data?.error?.message || data?.error_description || '';
    if (SESSION_IS_OVER.test(reason)) {
      throw new HttpError(401, 'Your session has expired — please sign in again.');
    }
    /* A 429 or a 5xx from Google is Google's problem, not this person's. */
    throw new SessionUnknownError(`${response.status} ${reason}`.trim());
  }

  if (!data.id_token) throw new SessionUnknownError('no id_token in a 200');

  const shaped = {
    access_token: data.id_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_in: Number(data.expires_in || 3600),
    /* The refresh response names only the uid; the address is inside the token
       it just issued. Reading it here spares the browser a lookup round-trip.
       This is display data — nothing is authorised on it. */
    user: { id: data.user_id, email: claimedEmail(data.id_token) }
  };
  rememberExchange(refreshToken, shaped);
  return shaped;
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
