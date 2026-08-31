/* Verifying a Firebase identity, without holding a Firebase secret.

   Firebase ID tokens are ordinary RS256 JWTs signed by Google with keys it
   publishes. Verifying one needs the project id and nothing else — no service
   account, no Admin SDK, no private key on disk or in an environment variable.
   The only thing that could be stolen from this file is knowledge of which
   project we trust.

   This module answers one question — "is this a token our project issued, and
   to whom" — and returns null for everything else. */

import { createRemoteJWKSet, jwtVerify, decodeJwt } from 'jose';
import { config } from '../config.js';

const GOOGLE_KEYS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let keys = null;
const jwks = () => (keys ??= createRemoteJWKSet(new URL(GOOGLE_KEYS)));

export const firebaseConfigured = () => Boolean(config.firebase.projectId);

/**
 * Returns { id, email, emailVerified, provider } for a valid Firebase token,
 * or null for anything this project should not trust — including a well-formed
 * token issued to a different Firebase project.
 */
export async function verifyFirebaseToken(token) {
  const project = config.firebase.projectId;
  if (!token || !project) return null;

  // Cheap rejection first: anything not issued by this project is refused
  // without spending a network call to find that out.
  try {
    const claims = decodeJwt(token);
    if (claims.iss !== `https://securetoken.google.com/${project}`) return null;
  } catch {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, jwks(), {
      issuer: `https://securetoken.google.com/${project}`,
      audience: project
    });
    if (!payload.sub) return null;
    return {
      id: payload.sub,
      email: payload.email || '',
      emailVerified: Boolean(payload.email_verified || payload.firebase?.sign_in_provider === 'google.com'),
      provider: 'firebase'
    };
  } catch {
    // Expired, tampered with, or signed by a key Google has retired.
    return null;
  }
}

/* ---------- Google sign-in readiness ----------

   Enabling Google in the Firebase console is only half the setup. This app
   sends people to Google directly over REST rather than through the Web SDK,
   so its own origin has to be listed as an authorised redirect URI on the
   OAuth client the console created. Until it is, Google answers the consent
   request with redirect_uri_mismatch.

   The browser cannot discover that on its own, and asking a person to keep a
   boolean in step with a setting in a different console is how a button ends
   up either missing or dead. So the server finds out for itself: it walks the
   first step of the real flow once and remembers the answer. Register the
   redirect URI and the button appears by itself within the hour; nothing to
   redeploy, nothing to toggle.

   FIREBASE_GOOGLE_AUTH=false still forces it off, for anyone who would rather
   not offer it at all. */

const PROBE_TTL_MS = 60 * 60 * 1000;
let googleProbe = { ready: false, reason: 'checking', checkedAt: 0, running: false };

/** Where Google is asked to return to. Must match what the browser sends.
 *
 * Firebase's own handler, not this app's origin. Sending our origin is what put
 * every deployment behind a manual Google Cloud Console change: identitytoolkit
 * passes continueUri through as the OAuth redirect_uri, so localhost and the
 * production domain each had to be registered by hand, and until they were,
 * Google answered redirect_uri_mismatch and the button could not work anywhere.
 * The handler is registered on the project's OAuth client by Firebase itself,
 * so this is the one redirect that is always already allowed. */
export const googleRedirectUri = () =>
  (config.firebase.authDomain ? `https://${config.firebase.authDomain}/__/auth/handler` : '');

async function probeGoogle() {
  const key = config.firebase.apiKey;
  if (!key) return { ready: false, reason: 'provider_disabled' };
  if (!config.firebase.authDomain) return { ready: false, reason: 'no_auth_domain' };
  try {
    /* One call, and it answers the only question left.
     *
     * This used to ask for an authorisation URL and then follow it all the way
     * to Google's consent screen, because the redirect URI was this app's own
     * origin and the only way to find out whether somebody had registered it
     * was to watch Google refuse. That question is gone: the redirect is now
     * Firebase's handler, which Firebase registers on every project's OAuth
     * client itself. What remains is whether Google is switched on as a
     * provider at all, and createAuthUri says so directly — it returns an
     * authUri when it is and OPERATION_NOT_ALLOWED when it is not.
     *
     * Dropping the second leg matters beyond tidiness. It was a redirect chase
     * ending in 800KB of markup, and on a serverless deployment the function is
     * frozen the moment it answers — so a probe started in the background never
     * finished, every cold start lost the race, and production reported the
     * button unavailable while the same code said otherwise locally. A probe
     * that cannot finish inside one request is not a probe, it is a guess. */
    const created = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: 'google.com',
          continueUri: googleRedirectUri(),
          authFlowType: 'CODE_FLOW',
          oauthScope: 'openid email profile'
        }),
        signal: AbortSignal.timeout(6000)
      }
    );
    const body = await created.json().catch(() => ({}));
    if (!created.ok || !body.authUri) return { ready: false, reason: 'provider_disabled' };
    return { ready: true, reason: 'ok' };
  } catch {
    // Unreachable or slow: offer nothing rather than a dead button.
    return { ready: false, reason: 'probe_failed' };
  }
}

/**
 * Whether to offer the Google button.
 *
 * A fresh answer is returned from memory; a stale or missing one is fetched
 * here, inside the request, and awaited.
 *
 * It deliberately keeps no promise between requests. The previous version
 * started a probe in the background and shared the pending promise with
 * whoever asked next, which is reasonable on a server that keeps running and
 * wrong on one that does not: Vercel freezes the function the moment it
 * answers, so that promise never settled, and every later request joined the
 * same dead wait and timed out. The button stayed hidden in production while
 * the identical code offered it locally. Only the result is cached now, so the
 * worst case is one extra call per cold start rather than a permanent no.
 */
const forcedOff = () => String(process.env.FIREBASE_GOOGLE_AUTH || '').toLowerCase() === 'false';
const probeIsFresh = () => googleProbe.checkedAt > 0 && Date.now() - googleProbe.checkedAt < PROBE_TTL_MS;

/**
 * What is already known about Google, without asking anybody.
 *
 * /api/config is the first request the browser makes and the one the whole
 * interface waits behind, so nothing in it may depend on a third party being
 * quick. Asking Google inline put a round trip to identitytoolkit in front of
 * the first paint — and on a cold serverless start, in front of a boot that
 * gives up and renders after ten seconds.
 *
 * So the fast path answers from memory and says 'checking' when it does not yet
 * know. The browser asks the endpoint below for the real answer afterwards,
 * where waiting costs nobody anything.
 */
export function googleSignInCached() {
  if (forcedOff()) return { ready: false, reason: 'turned_off' };
  if (!config.firebase.apiKey) return { ready: false, reason: 'provider_disabled' };
  if (probeIsFresh()) return { ready: googleProbe.ready, reason: googleProbe.reason };
  return { ready: false, reason: 'checking' };
}

/** The real answer, asking Google if the cached one is stale or missing. */
export async function googleSignInReady() {
  if (forcedOff()) return false;
  if (!config.firebase.apiKey) return false;
  if (probeIsFresh()) return googleProbe.ready;

  const result = await probeGoogle();
  googleProbe = { ...result, checkedAt: Date.now(), running: false };
  return googleProbe.ready;
}

/* Why the button is not being offered.
 *
 * Hiding a control that cannot work is right for the person trying to sign in —
 * a dead button is worse than no button. It is wrong for whoever has to fix it,
 * who otherwise sees nothing at all and has no way to tell "switched off" from
 * "misconfigured". The reason is therefore reported, and the interface shows it
 * only in development, where the person reading the screen is the one who can
 * act on it.
 *
 *   provider_disabled          Google is not enabled in the Firebase console
 *   no_auth_domain             no authDomain configured, so there is nowhere to
 *                              route the round trip through
 *   probe_failed               Google could not be reached to find out
 */
export const googleSignInReason = () => (forcedOff() ? 'turned_off' : googleProbe.reason);
