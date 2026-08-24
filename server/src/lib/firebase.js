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
