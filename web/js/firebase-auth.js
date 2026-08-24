/* Firebase Authentication over its REST API.

   Deliberately not the Firebase Web SDK. This app has no bundler, and its
   content-security policy allows scripts from its own origin only — pulling a
   megabyte of SDK from a CDN would mean loosening that. The REST endpoints do
   everything sign-in needs, in the same shape session.js already uses for
   GoTrue, and the only credential involved is the web api key, which Firebase
   publishes on purpose.

   This module knows nothing about the rest of the app. It signs in, signs up,
   refreshes, and reports failures in plain terms; session.js decides what that
   means for the interface. */

const IDENTITY = 'https://identitytoolkit.googleapis.com/v1/accounts';
const TOKEN = 'https://securetoken.googleapis.com/v1/token';

let apiKey = '';

export const configure = key => { apiKey = key || ''; };
export const isConfigured = () => Boolean(apiKey);

/* Firebase speaks in constants like EMAIL_NOT_FOUND. People do not. */
const HUMAN = {
  EMAIL_EXISTS: 'auth.errTaken',
  EMAIL_NOT_FOUND: 'auth.errWrongPair',
  INVALID_PASSWORD: 'auth.errWrongPair',
  INVALID_LOGIN_CREDENTIALS: 'auth.errWrongPair',
  INVALID_EMAIL: 'auth.errBadEmail',
  WEAK_PASSWORD: 'auth.errWeak',
  USER_DISABLED: 'auth.errDisabled',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'auth.errTooMany',
  OPERATION_NOT_ALLOWED: 'auth.errProviderOff',
  CONFIGURATION_NOT_FOUND: 'auth.errProviderOff'
};

/** The key for a human sentence, or '' when this is not a failure we know. */
export const reasonKey = code => {
  const found = Object.keys(HUMAN).find(known => String(code).startsWith(known));
  return found ? HUMAN[found] : '';
};

async function call(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = data?.error?.message || 'UNKNOWN';
    const failure = new Error(code);
    failure.code = code;
    failure.reasonKey = reasonKey(code);
    /* Firebase has not been switched on for this project at all — a different
       situation from a wrong password, and the caller may want to fall back. */
    failure.providerUnavailable = /CONFIGURATION_NOT_FOUND|OPERATION_NOT_ALLOWED/.test(code);
    throw failure;
  }
  return data;
}

const shape = data => ({
  uid: data.localId,
  email: data.email || '',
  idToken: data.idToken,
  refreshToken: data.refreshToken,
  expiresIn: Number(data.expiresIn || 3600)
});

export const signUp = (email, password) =>
  call(`${IDENTITY}:signUp?key=${apiKey}`, { email, password, returnSecureToken: true }).then(shape);

export const signIn = (email, password) =>
  call(`${IDENTITY}:signInWithPassword?key=${apiKey}`, { email, password, returnSecureToken: true }).then(shape);

export const sendPasswordReset = email =>
  call(`${IDENTITY}:sendOobCode?key=${apiKey}`, { requestType: 'PASSWORD_RESET', email });

export const sendVerification = idToken =>
  call(`${IDENTITY}:sendOobCode?key=${apiKey}`, { requestType: 'VERIFY_EMAIL', idToken });

export const updateProfile = (idToken, displayName) =>
  call(`${IDENTITY}:update?key=${apiKey}`, { idToken, displayName, returnSecureToken: false });

/** Exchanges a refresh token for a fresh id token. */
export async function refresh(refreshToken) {
  const response = await fetch(`${TOKEN}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || 'REFRESH_FAILED');
  return {
    uid: data.user_id,
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresIn: Number(data.expires_in || 3600)
  };
}

/** The account behind a token — used to know whether the address is verified. */
export const lookup = idToken =>
  call(`${IDENTITY}:lookup?key=${apiKey}`, { idToken })
    .then(data => data.users?.[0] || null);

/** Changes the password of the signed-in account; returns a fresh token pair. */
export const changePassword = (idToken, password) =>
  call(`${IDENTITY}:update?key=${apiKey}`, { idToken, password, returnSecureToken: true })
    .then(data => ({ idToken: data.idToken, refreshToken: data.refreshToken }));

/* ---------- Google ----------

   The redirect flow, done over REST. Firebase mints the authorisation URL with
   its own OAuth client, so there is no client id or secret for this app to hold:
   ask for a URL, send the person to Google, and hand the URL they come back with
   to signInWithIdp. The sessionId ties the two halves together and is the reason
   a stray callback URL cannot be replayed into somebody else's session. */

const GOOGLE_SESSION = 'diiwaan.google.session';

/** Where Google returns to. Must be listed under Authentication → Authorised domains. */
const continueUri = () => `${location.origin}/`;

/** Step one: ask Firebase for the URL to send the person to. */
export async function startGoogle() {
  const data = await call(`${IDENTITY}:createAuthUri?key=${apiKey}`, {
    providerId: 'google.com',
    continueUri: continueUri(),
    authFlowType: 'CODE_FLOW',
    oauthScope: 'openid email profile'
  });
  if (!data.authUri || !data.sessionId) throw new Error('OPERATION_NOT_ALLOWED');
  /* sessionStorage, not localStorage: this belongs to one tab making one trip
     to Google, and it should not outlive either. */
  sessionStorage.setItem(GOOGLE_SESSION, data.sessionId);
  return data.authUri;
}

/** True when this page load is Google returning with an answer. */
export const isGoogleCallback = () => {
  const query = new URLSearchParams(location.search);
  return Boolean(sessionStorage.getItem(GOOGLE_SESSION))
    && (query.has('code') || query.has('error'));
};

/** Step two: trade the URL Google sent us back to for a real session. */
export async function finishGoogle() {
  const sessionId = sessionStorage.getItem(GOOGLE_SESSION);
  sessionStorage.removeItem(GOOGLE_SESSION);

  const query = new URLSearchParams(location.search);
  if (query.get('error')) {
    const failure = new Error(query.get('error'));
    // A cancelled consent screen is a decision, not a fault. Say nothing.
    failure.cancelled = /access_denied|user_cancel/i.test(query.get('error'));
    throw failure;
  }
  if (!sessionId) throw new Error('SESSION_EXPIRED');

  const data = await call(`${IDENTITY}:signInWithIdp?key=${apiKey}`, {
    requestUri: location.href,
    sessionId,
    returnSecureToken: true
  });
  return { ...shape(data), name: data.displayName || '' };
}
