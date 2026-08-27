/* Firebase Authentication over its REST API.

   Email and password go over REST. This app has no bundler, and its
   content-security policy allows scripts from its own origin only, so pulling
   the SDK from a CDN for the ordinary path would mean loosening that for no
   gain: the REST endpoints do everything a password sign-in needs, and the only
   credential involved is the web api key, which Firebase publishes on purpose.

   Google is the exception, and the reason is Google's, not ours. Asking
   identitytoolkit for an authorisation URL puts our own origin in the request
   as the OAuth redirect_uri, so every origin the app is served from has to be
   registered by hand on the OAuth client — and until someone does that, Google
   answers redirect_uri_mismatch and the button cannot work anywhere. Measured:
   both http://localhost:4173/ and https://diiwaan-so.vercel.app/ refused.

   Firebase's own handler at <authDomain>/__/auth/handler is registered on that
   client already, by Firebase, for every project. Routing the round trip
   through it is what makes Google sign-in work without a console change, and
   the supported way to drive that handler is the SDK — so the SDK is vendored
   into web/vendor and imported from our own origin, which keeps script-src
   'self' exactly as it was. It is loaded only when somebody actually presses
   the Google button.

   The SDK is a way to obtain a credential, not a second session. Its own
   persistence is session-scoped and cleared the moment the credential is
   handed over, because the refresh token still goes to our API and still ends
   up in the same HttpOnly cookie every other sign-in uses. One identity model,
   one session.

   This module knows nothing about the rest of the app. It signs in, signs up,
   refreshes, and reports failures in plain terms; session.js decides what that
   means for the interface. */

const IDENTITY = 'https://identitytoolkit.googleapis.com/v1/accounts';
const TOKEN = 'https://securetoken.googleapis.com/v1/token';

let apiKey = '';
/* The rest of the project config, needed only by the Google path: the SDK is
   initialised with the same values /api/config already hands the browser. */
let projectConfig = null;

export const configure = (key, project) => {
  apiKey = key || '';
  projectConfig = key ? (project || null) : null;
};
export const isConfigured = () => Boolean(apiKey);
/** Google needs an auth domain to route through; without one it cannot be offered. */
export const canUseGoogle = () => Boolean(apiKey && projectConfig?.authDomain);

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

   The round trip goes through Firebase's own handler rather than straight to
   Google, because that handler is the only redirect URI on this OAuth client
   that Google already accepts. The SDK owns that protocol — the handler is a
   client-side page with an undocumented contract, not a redirect worth
   reimplementing on guesswork in the one place a mistake means broken sign-in.

   Loaded on demand, from our own origin, so nothing is fetched for a visitor
   who never presses the button and script-src stays 'self'. */

/** Set before leaving, read on the way back: the SDK's own pending state is
    inside the SDK, and this decides whether it is worth loading at all. */
const GOOGLE_PENDING = 'diiwaan:google-pending';

/* What actually goes wrong on the way back, said in terms of what to do next.
 *
 * Every one of these used to arrive as "That Google sign-in did not complete.
 * Please try again" — advice that is merely useless for a network blip and
 * actively wrong for the first case, where trying again will fail the same way
 * forever and the thing to do is use the password that already exists. */
const GOOGLE_HUMAN = {
  'auth/account-exists-with-different-credential': 'auth.errGoogleTakenByPassword',
  'auth/email-already-in-use': 'auth.errGoogleTakenByPassword',
  'auth/credential-already-in-use': 'auth.errGoogleTakenByPassword',
  'auth/user-disabled': 'auth.errDisabled',
  'auth/network-request-failed': 'auth.googleUnreachable',
  'auth/too-many-requests': 'auth.errTooMany',
  'auth/unauthorized-domain': 'auth.googleOffRedirect',
  'auth/operation-not-allowed': 'auth.googleOffProvider'
};

/** The key for a human sentence about a Google failure, or '' when unknown. */
export const googleReasonKey = code => GOOGLE_HUMAN[String(code)] || '';

let sdk = null;

async function googleSdk() {
  if (sdk) return sdk;
  sdk = (async () => {
    const [app, auth] = await Promise.all([
      import('../vendor/firebase-app.js'),
      import('../vendor/firebase-auth.js')
    ]);
    const existing = app.getApps();
    const instance = existing.length ? app.getApp() : app.initializeApp({
      apiKey,
      authDomain: projectConfig.authDomain,
      projectId: projectConfig.projectId,
      appId: projectConfig.appId
    });
    const client = auth.getAuth(instance);
    /* Session-scoped, not the SDK default. The redirect throws this tab away
       and comes back, so the pending sign-in has to survive that much and no
       more — a second, longer-lived session sitting beside our cookie is the
       thing this deliberately does not create. */
    await auth.setPersistence(client, auth.browserSessionPersistence);
    return { auth, client };
  })();
  return sdk;
}

/** Hands the browser to Google. Control leaves this page; finishGoogle resumes. */
export async function startGoogle() {
  if (!canUseGoogle()) {
    const failure = new Error('OPERATION_NOT_ALLOWED');
    failure.code = 'OPERATION_NOT_ALLOWED';
    throw failure;
  }
  const { auth, client } = await googleSdk();
  const provider = new auth.GoogleAuthProvider();
  provider.addScope('email');
  provider.addScope('profile');
  /* Always ask which account. Without it a person with several Google accounts
     is silently signed in as whichever one the browser saw last, which on a
     shared desk is somebody else's. */
  provider.setCustomParameters({ prompt: 'select_account' });
  try { sessionStorage.setItem(GOOGLE_PENDING, '1'); } catch { /* private mode */ }
  await auth.signInWithRedirect(client, provider);
}

/** True when this page load is Google coming back with an answer. */
export const isGoogleCallback = () => {
  try { return sessionStorage.getItem(GOOGLE_PENDING) === '1'; } catch { return false; }
};

/**
 * Collects the credential Google returned and gives it up immediately.
 *
 * The refresh token goes to our own API, which seals it in the HttpOnly cookie
 * every other sign-in uses, so a Google account and an email account are the
 * same Diiwaan identity from here on. The SDK is signed out in the same breath:
 * holding a second session would mean two things that both believe they know
 * who is signed in, and eventually they disagree.
 */
export async function finishGoogle() {
  try { sessionStorage.removeItem(GOOGLE_PENDING); } catch { /* private mode */ }
  const { auth, client } = await googleSdk();

  let result;
  try {
    result = await auth.getRedirectResult(client);
  } catch (error) {
    const failure = new Error(error?.code || 'GOOGLE_FAILED');
    failure.code = error?.code || '';
    // A cancelled consent screen is a decision, not a fault worth reporting.
    failure.cancelled = /popup-closed|cancelled-popup|user-cancelled/.test(failure.code);
    failure.reasonKey = googleReasonKey(failure.code);
    throw failure;
  }

  if (!result?.user) {
    // Came back with nothing: the person turned around at the consent screen.
    const failure = new Error('CANCELLED');
    failure.cancelled = true;
    throw failure;
  }

  const account = { refreshToken: result.user.refreshToken, name: result.user.displayName || '' };
  await auth.signOut(client).catch(() => {});
  return account;
}
