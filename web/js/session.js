/* Owner identity in the browser.

   Firebase Authentication owns the credentials; firebase-auth.js speaks its REST
   API directly, with no SDK bundle. The long-lived refresh token is handed
   straight to our backend, which seals it in an HttpOnly cookie, so no auth
   secret is ever written to localStorage and an XSS bug cannot walk off with a
   session. The tab keeps a short-lived id token in memory and renews it from the
   cookie on page load and shortly before it expires. */

import { t } from './i18n.js';
import * as firebase from './firebase-auth.js';

let runtime = null;
let renewTimer = null;
const listeners = new Set();

export const state = {
  ready: false,
  session: null,      // { accessToken, expiresAt, user } — memory only
  user: null,         // our own MongoDB profile view
  businesses: [],
  needsVerification: false,
  /* Set when the app cannot talk to its own API at all. Distinct from a wrong
     password: nothing the person types will help until it is cleared. */
  backendError: '',
};

const emit = () => listeners.forEach(fn => fn(state));
export function onSessionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const accessToken = () => state.session?.accessToken || null;
export const isSignedIn = () => Boolean(state.session);
export const userId = () => state.session?.user?.id || null;
export const appUrl = () => runtime?.appUrl || location.origin;
export const googleAuthAvailable = () => Boolean(runtime?.googleAuth) && firebase.isConfigured();

/** Set when a provider sent us back with a refusal instead of a session. */
export let oauthError = '';

/* Google supplies a display name; our own profile may not have one yet. Held
   here so the first /api/auth/me after a Google sign-in can adopt it. */
export let googleName = '';
export const clearGoogleName = () => { googleName = ''; };

/* ---------- provider errors ---------- */

/* Firebase answers in constants. These are the ones a person actually meets,
   said in their own language — and each names what to do next, not merely what
   went wrong. A raw code never reaches the screen. */
function firebaseFailure(error) {
  const failure = new Error(error?.reasonKey ? t(error.reasonKey) : t('common.wentWrong'));
  failure.reason = error?.code || '';
  return failure;
}

/* Guards every call that needs the provider. Without it a misconfigured
   deployment fails deep inside a fetch with a message about credentials. */
function requireProvider() {
  if (!firebase.isConfigured()) {
    throw new Error(state.backendError || t('auth.errProviderOff'));
  }
}

/* Firebase lets an unverified account straight in, so nothing is ever blocked
   on a link nobody clicked. Kept so callers need not care which provider is in
   use; it is simply never true now. */
export const isUnconfirmed = () => false;

/* ---------- our session cookie ---------- */

const sessionFetch = (method, body) => fetch('/api/auth/session', {
  method,
  credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json', 'X-Diiwaan-Client': 'web' },
  body: body === undefined ? undefined : JSON.stringify(body)
});

function adopt(payload) {
  state.session = {
    accessToken: payload.accessToken,
    expiresAt: Math.floor(Date.now() / 1000) + payload.expiresIn,
    user: payload.user
  };
  clearTimeout(renewTimer);
  // Renew a minute early so no request ever races the clock.
  renewTimer = setTimeout(() => restore().catch(() => signOut()), Math.max(30, payload.expiresIn - 60) * 1000);
  emit();
  return state.session;
}

async function handOver(refreshToken) {
  const response = await sessionFetch('POST', { refreshToken });
  if (!response.ok) throw new Error('We could not start your session. Please try again.');
  return adopt(await response.json());
}

/** Restores the session held in the HttpOnly cookie; null when there is none. */
export async function restore() {
  try {
    const response = await sessionFetch('GET');
    if (!response.ok || response.status === 204) return null;
    return adopt(await response.json());
  } catch {
    return null;
  }
}

/* ---------- lifecycle ---------- */

/* Boot must finish. Every network call it makes is capped, because the one
   thing the app must never do is hold a blank loading screen open waiting for a
   server that is slow, asleep or unreachable. A call that overruns is treated as
   a failure and the interface renders — signed out, with the reason on screen —
   rather than not rendering at all. */
function withDeadline(promise, ms, reason) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(reason)), ms))
  ]);
}

export async function boot() {
  /* Everything the browser does with identity needs this handshake first. When
     it fails — an unconfigured deployment, an API that cannot start, a network
     that is down — every later call would fail too, with a message about
     passwords that has nothing to do with the real problem. So the failure is
     recorded here, once, in the words of what actually happened. */
  try {
    const response = await withDeadline(
      fetch('/api/config'), 8000, 'The service took too long to answer.'
    );
    const body = await response.json();
    if (!response.ok || !body.firebase?.apiKey) {
      runtime = null;
      firebase.configure('');
      state.backendError = body?.detail || body?.error || t('auth.serviceReplied', { status: response.status });
    } else {
      runtime = body;
      firebase.configure(body.firebase?.apiKey);
      state.backendError = '';
    }
  } catch (error) {
    runtime = null;
    firebase.configure('');
    state.backendError = t('auth.serviceUnreachable');
  }

  /* Google returning with an answer. This has to be settled before the ordinary
     session restore, or the app would render signed out for a moment and then
     jump — and the query string has to be scrubbed either way, so a stale
     authorisation code is never left sitting in the address bar or in history. */
  if (firebase.isGoogleCallback()) {
    try {
      const account = await withDeadline(firebase.finishGoogle(), 12000, 'timeout');
      await handOver(account.refreshToken);
      if (account.name) googleName = account.name;
    } catch (error) {
      // A cancelled consent screen is a decision, not a failure worth reporting.
      if (!error?.cancelled) oauthError = t('auth.errGoogleFailed');
    }
    history.replaceState(null, '', `${location.pathname}#/${isSignedIn() ? 'queue' : 'signin'}`);
  }

  /* A session restore that stalls must not hold the whole interface hostage:
     failing it simply means signed out, which is a state the app can render. */
  if (!isSignedIn()) await withDeadline(restore(), 8000, 'timeout').catch(() => null);

  state.ready = true;
  emit();
  return runtime;
}

/* ---------- credentials ---------- */

export async function signUp({ email, password, name }) {
  requireProvider();
  try {
    const account = await firebase.signUp(email, password);
    if (name) await firebase.updateProfile(account.idToken, name).catch(() => {});
    /* The letter goes out, because a verified address is what binds staff
       invitations and links an older account. But nobody is held at the door
       for it: the queue opens now and the address can be confirmed later. */
    await firebase.sendVerification(account.idToken).catch(() => {});
    await handOver(account.refreshToken);
    state.needsVerification = false;
    emit();
    return { needsVerification: false };
  } catch (error) {
    throw firebaseFailure(error);
  }
}

/**
 * Hands the browser to Google. Control leaves this page and comes back to the
 * app's own origin, where boot() finishes the exchange — the two halves are
 * deliberately separate, because a redirect means the tab is thrown away in
 * between and nothing can be kept in memory across it.
 */
export async function startGoogle() {
  requireProvider();
  try {
    location.assign(await firebase.startGoogle());
  } catch (error) {
    throw firebaseFailure(error);
  }
}

export async function signIn({ email, password }) {
  requireProvider();
  try {
    const account = await firebase.signIn(email, password);
    await handOver(account.refreshToken);
    state.needsVerification = false;
    return state.session;
  } catch (error) {
    throw firebaseFailure(error);
  }
}

/**
 * Signing out is local first: the tab forgets the session in the same tick as
 * the click, so the interface can move immediately. Dropping the cookie happens
 * on the way out — the returned promise is there for callers that want to know
 * when it finished, not for the person leaving.
 */
export function signOut() {
  clearTimeout(renewTimer);
  state.session = null;
  state.user = null;
  state.businesses = [];
  state.needsVerification = false;
  emit();
  return sessionFetch('DELETE').catch(() => {});
}

export async function sendReset(email) {
  requireProvider();
  try {
    await firebase.sendPasswordReset(email);
  } catch (error) {
    /* Whether an address is registered is not something this screen should
       reveal — it would turn the reset form into a way to enumerate accounts.
       An unknown address reports the same success as a known one. */
    if (error?.code?.startsWith('EMAIL_NOT_FOUND')) return;
    throw firebaseFailure(error);
  }
}

export async function resendVerification() {
  requireProvider();
  if (!accessToken()) throw new Error(t('auth.errSessionGone'));
  try {
    await firebase.sendVerification(accessToken());
  } catch (error) {
    throw firebaseFailure(error);
  }
}

export async function updatePassword(password) {
  requireProvider();
  try {
    const data = await firebase.changePassword(accessToken(), password);
    // A password change mints a new pair; adopting it keeps the tab signed in.
    if (data.refreshToken) await handOver(data.refreshToken);
  } catch (error) {
    throw firebaseFailure(error);
  }
}

/** Re-reads the account from Firebase — the authority on whether it is verified. */
export async function refreshVerification() {
  if (!accessToken()) return false;
  try {
    const account = await firebase.lookup(accessToken());
    const verified = Boolean(account?.emailVerified);
    if (verified) {
      /* The in-memory token still claims otherwise until it is reissued, and
         the server reads that claim — so mint a fresh one before asking again. */
      await restore();
    }
    return verified;
  } catch {
    return false;
  }
}

/* ---------- branding uploads ---------- */

const ALLOWED = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * Uploads branding art through our own API, which checks the file's real bytes,
 * stores it beside everything else the business owns and returns the path it is
 * served from. The request is authorised the same way every other owner call
 * is, so one business can never write over another's artwork.
 */
export async function uploadBrandingImage(file, { businessId } = {}) {
  if (!accessToken()) throw new Error(t('auth.errSessionGone'));
  if (!businessId) throw new Error(t('common.wentWrong'));
  if (!ALLOWED.includes(file.type)) throw new Error(t('brand.useImageType'));

  const body = new FormData();
  body.append('file', file);

  const response = await fetch(`/api/businesses/${businessId}/logo`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken()}` },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || t('brand.uploadFailed'));
  return data.url;
}

/** Called after any sign-in: our API supplies the profile and businesses. */
export function setAccount({ user, businesses }) {
  state.user = user;
  state.businesses = businesses;
  state.needsVerification = user ? user.emailVerified === false : false;
  emit();
}
