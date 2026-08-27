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
      emailVerified: Boolean(payload.email_verified),
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

/* The probe in flight, so a request that arrives before the first one lands can
   wait for it rather than being told "no".
 *
 * This is the difference between a button that appears and one that never does.
 * /api/config is fetched exactly once, at boot, and the answer is kept for the
 * whole session — so on a cold server the first visitor asked before any probe
 * had finished, got `ready: false`, and had no Google button until they
 * happened to reload. On a serverless deployment every cold start is somebody's
 * first visit, so with the redirect URI correctly registered the button could
 * still be missing for most people, most of the time. */
let googleProbeInFlight = null;

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
    const created = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: 'google.com',
          continueUri: googleRedirectUri(),
          authFlowType: 'CODE_FLOW',
          /* The same scopes the browser asks for. A probe of a different
             request is a probe of a different question. */
          oauthScope: 'openid email profile'
        }),
        signal: AbortSignal.timeout(6000)
      }
    );
    const { authUri } = await created.json();
    if (!authUri) return { ready: false, reason: 'provider_disabled' };

    /* Following the URL is the only honest test: createAuthUri succeeds
       whatever the redirect URI is, and Google only objects at the consent
       step.

       A refusal lands on accounts.google.com/signin/oauth/error with the reason
       in an `authError` parameter, base64url of a protobuf whose readable parts
       still name it. Reading the landing URL is what makes this reliable — the
       rendered page is 800KB of markup in whatever language Google picked, and
       matching a string in it is a coin toss. Success lands anywhere else: the
       account chooser, a consent screen, or straight back to us if the person
       already has a Google session. */
    const consent = await fetch(authUri, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
    const landing = new URL(consent.url);
    /* The verdict is in the URL, so the body — 800KB of consent or error markup
       — is never read. Unread, it holds its socket open until the pool notices;
       cancelling hands it back now. */
    consent.body?.cancel().catch(() => {});
    if (!/\/signin\/oauth\/error/.test(landing.pathname)) return { ready: true, reason: 'ok' };

    let detail = landing.searchParams.get('authError') || '';
    try {
      detail = Buffer.from(detail.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    } catch { /* keep it as it came; only the reason below is derived from it */ }

    return /redirect_uri_mismatch/i.test(detail)
      ? { ready: false, reason: 'redirect_uri_unregistered' }
      : { ready: false, reason: 'provider_refused' };
  } catch {
    // Unreachable or slow: offer nothing rather than a dead button.
    return { ready: false, reason: 'probe_failed' };
  }
}

/** Starts a probe if the answer is missing or stale. Returns the one in flight. */
function refreshGoogleProbe() {
  if (googleProbeInFlight) return googleProbeInFlight;
  googleProbe.running = true;
  googleProbeInFlight = probeGoogle()
    .catch(() => ({ ready: false, reason: 'probe_failed' }))
    .then(result => {
      googleProbe = { ...result, checkedAt: Date.now(), running: false };
      googleProbeInFlight = null;
      return googleProbe;
    });
  return googleProbeInFlight;
}

/**
 * Whether to offer the Google button, waiting for a first answer if one is
 * still coming.
 *
 * A known answer is returned immediately and a stale one is refreshed in the
 * background, so the common request costs nothing. Only the case where nothing
 * is known yet waits, and it waits with a deadline: /api/config is what the
 * browser blocks on before it can render, so being slow here is a blank screen.
 * Past the deadline the honest answer is "not yet", and the probe carries on so
 * the next request has it.
 */
export async function googleSignInReady({ wait = 3000 } = {}) {
  if (String(process.env.FIREBASE_GOOGLE_AUTH || '').toLowerCase() === 'false') return false;
  if (!config.firebase.apiKey) return false;

  const known = googleProbe.checkedAt > 0;
  const stale = Date.now() - googleProbe.checkedAt > PROBE_TTL_MS;

  if (known && !stale) return googleProbe.ready;
  const pending = refreshGoogleProbe();
  // A stale answer is still an answer; refresh behind it rather than blocking.
  if (known) return googleProbe.ready;

  const settled = await Promise.race([
    pending,
    new Promise(resolve => setTimeout(() => resolve(null), wait))
  ]);
  return settled ? settled.ready : false;
}

/* Asked at start-up rather than on the first request, so a server that has been
   up for a moment already knows the answer by the time anyone asks. */
export const warmGoogleProbe = () => {
  if (String(process.env.FIREBASE_GOOGLE_AUTH || '').toLowerCase() === 'false') return;
  if (config.firebase.apiKey) refreshGoogleProbe();
};

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
 *   redirect_uri_unregistered  enabled, but Firebase's own auth handler is not
 *                              an authorised redirect URI on the OAuth client
 *   no_auth_domain             no authDomain configured, so there is nowhere to
 *                              route the round trip through
 *   provider_refused           Google refused the request for some other reason
 *   probe_failed               Google could not be reached to find out
 */
export const googleSignInReason = () =>
  (String(process.env.FIREBASE_GOOGLE_AUTH || '').toLowerCase() === 'false'
    ? 'turned_off'
    : googleProbe.reason);
