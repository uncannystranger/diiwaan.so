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
let googleProbe = { ready: false, checkedAt: 0, running: false };

/** Where Google is asked to return to. Must match what the browser sends. */
export const googleRedirectUri = () => `${config.appUrl.replace(/\/+$/, '')}/`;

async function probeGoogle() {
  const key = config.firebase.apiKey;
  if (!key) return false;
  try {
    const created = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: 'google.com',
          continueUri: googleRedirectUri(),
          authFlowType: 'CODE_FLOW'
        }),
        signal: AbortSignal.timeout(6000)
      }
    );
    const { authUri } = await created.json();
    if (!authUri) return false;

    /* Following the URL is the only honest test: createAuthUri succeeds
       whatever the redirect URI is, and Google only objects at the consent
       step. A rejection renders as a page naming the reason. */
    const consent = await fetch(authUri, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
    const page = await consent.text();
    return !/redirect_uri_mismatch/i.test(page);
  } catch {
    return false; // unreachable or slow: offer nothing rather than a dead button
  }
}

/** Cheap and synchronous. Refreshes itself in the background when stale. */
export function googleSignInReady() {
  if (String(process.env.FIREBASE_GOOGLE_AUTH || '').toLowerCase() === 'false') return false;
  if (!config.firebase.apiKey) return false;

  const stale = Date.now() - googleProbe.checkedAt > PROBE_TTL_MS;
  if (stale && !googleProbe.running) {
    googleProbe.running = true;
    // Deliberately not awaited: /api/config is what the browser waits on before
    // it can render anything, and it answers from memory for that reason.
    probeGoogle()
      .then(ready => { googleProbe = { ready, checkedAt: Date.now(), running: false }; })
      .catch(() => { googleProbe = { ready: false, checkedAt: Date.now(), running: false }; });
  }
  return googleProbe.ready;
}
