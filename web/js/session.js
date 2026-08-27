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
  /* The authentication lifecycle, as one value rather than several booleans.
     Everything that has to wait for identity waits on this, and nothing is
     allowed to guess while it reads 'initializing'.

       initializing    boot has not finished; no route decision may be made yet
       authenticated   a session was restored or created
       unauthenticated boot finished and there is no session
       error           the app could not reach its own API at all

     'error' is deliberately distinct from 'unauthenticated': one means nobody
     is signed in, the other means we do not know and nothing the person types
     will help. Showing a sign-in form for the second is a lie. */
  phase: 'initializing',
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

/** True until boot has resolved identity. No routing decision is valid before this clears. */
export const isInitializing = () => state.phase === 'initializing';

/**
 * Declares identity resolved when boot itself never managed to.
 *
 * The gate that stops the router guessing would otherwise become a way for the
 * app to hang: if boot never returns, the phase never leaves 'initializing' and
 * nothing may render. This is the deliberate end of that wait — not a delay
 * that hides a race, but a decision that the answer is not coming.
 *
 * It settles to whatever is actually known. A session that was restored before
 * the stall still counts; anything else is an error state, because "we could
 * not find out" is not the same as "nobody is signed in".
 */
/* What boot actually established, in one place, because two paths now reach it:
   a restore that answered in time, and one that answered afterwards. */
function settlePhase() {
  state.phase = isSignedIn() ? 'authenticated'
    : state.backendError ? 'error'
      : 'unauthenticated';
}

export function abandonBoot() {
  if (state.phase !== 'initializing') return;
  state.phase = isSignedIn() ? 'authenticated' : 'error';
  if (state.phase === 'error' && !state.backendError) {
    state.backendError = t('auth.serviceUnreachable');
  }
  emit();
}
export const userId = () => state.session?.user?.id || null;
export const appUrl = () => runtime?.appUrl || location.origin;
/** Which deployment this is. Configuration notes are for the others. */
export const isProduction = () => runtime?.env === 'production';
export const googleAuthAvailable = () => Boolean(runtime?.googleAuth) && firebase.canUseGoogle();

/* Present only outside production, and only when the button is being withheld.
   It is a note to whoever can fix the configuration, not a message to anyone
   signing in. */
export const googleAuthReason = () => (runtime?.googleAuthReason || '');

/** Fetches the Google SDK ahead of a click, so the popup opens inside the gesture. */
export const warmGoogle = () => firebase.warmGoogle();

/**
 * Asks whether Google will have us, after the interface is already on screen.
 *
 * /api/config used to carry this answer, which meant the first paint waited on
 * a round trip to identitytoolkit — and on a cold start, on a boot that gives up
 * and renders without it. The answer is worth having and worth nobody waiting
 * for, so it arrives late and the button appears when it does.
 */
export async function confirmGoogle() {
  if (!runtime || runtime.googleAuthReason !== 'checking') return;
  try {
    const response = await fetch('/api/config/google');
    if (!response.ok) return;
    const answer = await response.json();
    if (runtime.googleAuth === answer.googleAuth && runtime.googleAuthReason === answer.googleAuthReason) return;
    runtime = { ...runtime, ...answer };
    emit();   // the screens read availability through us, so this repaints them
  } catch { /* the button stays as it is; nothing here is worth an error */ }
}

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
  /* Closing the Google window is a decision, not a fault. Carried through so
     the screen can stay quiet about it rather than reporting a failure to
     somebody who chose not to continue. */
  failure.cancelled = Boolean(error?.cancelled);
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
  state.phase = 'authenticated';
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
  if (!response.ok) {
    /* Every failure here used to read "we could not start your session", which
       is true and useless. The credentials were right — Firebase already
       accepted them — so the person is left retyping a password that was never
       the problem. The two that actually happen are worth naming: too many
       attempts in a minute, and a service that is not answering. */
    const failure = new Error(
      response.status === 429 ? t('auth.errTooMany')
        : response.status >= 500 ? t('auth.serviceUnreachable')
          : t('auth.errSessionStart')
    );
    failure.status = response.status;
    throw failure;
  }
  return adopt(await response.json());
}

/** True while a restore is in flight — we do not yet know whether anyone is signed in. */
let restoring = false;
export const isRestoring = () => restoring;

/** Restores the session held in the HttpOnly cookie; null when there is none. */
export async function restore() {
  restoring = true;
  try {
    const response = await sessionFetch('GET');
    if (!response.ok || response.status === 204) return null;
    return adopt(await response.json());
  } catch {
    return null;
  } finally {
    restoring = false;
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
      firebase.configure(body.firebase?.apiKey, body.firebase);
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
      /* A cancelled consent screen is a decision, not a failure worth
         reporting. Everything else says what happened, and the one that
         matters most says what to do instead: an account already held by a
         password will never open with Google, however many times it is tried. */
      if (!error?.cancelled) {
        oauthError = error?.reasonKey ? t(error.reasonKey) : t('auth.errGoogleFailed');
      }
    }
    const intended = sessionStorage.getItem('diiwaan:after-google');
    sessionStorage.removeItem('diiwaan:after-google');
    const back = isSignedIn() ? (intended || 'queue') : 'signin';
    /* The address bar is rewritten either way, so nothing the handler appended
       is left sitting in history for the next person on this device. */
    history.replaceState(null, '', `${location.pathname}#/${back}`);
  }

  /* A session restore that stalls must not hold the whole interface hostage —
     but giving up waiting is not the same as finding out there is no session,
     and boot used to conclude the second from the first. A restore slower than
     this deadline left a signed-in owner on the public landing page, and left
     them there: the restore completed a moment later and flipped the phase, but
     nothing re-resolved the route, so the landing page simply stayed until the
     person clicked something. Measured at an 11-second restore, the app showed
     landing from 11.3s to 20s while the session endpoint answered 200.

     So the two outcomes are now distinguished. A restore that answers is the
     truth, either way. A restore that overruns is unknown, and `restore()`
     keeps running — when it lands, adopt() flips the phase and the router
     re-resolves, because app.js now treats a change in authenticated-ness as a
     routing event rather than a repaint. */
  let pending = null;
  if (!isSignedIn()) {
    pending = restore();
    await withDeadline(pending, 8000, 'timeout').catch(() => {});
  }

  /* A restore still in flight is not an answer, and the public landing page is
     not a neutral thing to show while waiting for one — an owner watching their
     own dashboard get replaced by a marketing page has been told they are
     signed out. So the phase stays 'initializing', which keeps the boot screen
     up, and the pending restore settles it when it lands.
     
     This is not a delay papering over a race: nothing is being waited out. The
     state is genuinely unknown, the interface says so with a loading screen,
     and the moment it becomes known the router re-resolves. app.js keeps an
     absolute ceiling so an answer that never comes still ends in a rendered
     page rather than a spinner forever. */
  if (pending && restoring) {
    pending.finally(() => { settlePhase(); emit(); });
    return runtime;
  }

  settlePhase();
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

  /* The server asks Google whether this project offers the provider at all, and
     answers with a reason rather than a boolean. Saying so here is kinder than
     sending somebody to Google to read an error page about a configuration they
     cannot change — but it has to say the true thing.

     "Not set up yet, use your email and password" was said for every one of
     these, including the case where Google simply could not be reached, which
     told a person to give up on a method that would have worked a minute later.
     Switched off is permanent and worth redirecting away from; unreachable is
     temporary and worth retrying. */
  if (runtime && runtime.googleAuth === false) {
    const transient = runtime.googleAuthReason === 'probe_failed';
    const failure = new Error(t(transient ? 'auth.googleUnreachable' : 'auth.googleUnavailable'));
    failure.reason = runtime.googleAuthReason || 'google_unavailable';
    throw failure;
  }

  try {
    /* Where to come back to. The round trip through Google replaces this page,
       so the intended destination cannot be held in memory across it — and
       landing everyone on the queue would throw away an invitation link or a
       half-finished setup. Session-scoped, because it belongs to this one trip. */
    const from = location.hash.replace(/^#\/?/, '');
    if (from && !['signin', 'signup'].includes(from)) {
      sessionStorage.setItem('diiwaan:after-google', from);
    }
    /* Comes back with the credential when the popup completed, or null when the
       browser refused a popup and the page has been sent to Google instead —
       in which case this tab is on its way out and boot() resumes on return. */
    const account = await firebase.startGoogle();
    if (!account) return null;

    await handOver(account.refreshToken);
    if (account.name) googleName = account.name;
    state.needsVerification = false;
    emit();
    return state.session;
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
  verificationSent = false;
  state.session = null;
  state.user = null;
  state.businesses = [];
  state.needsVerification = false;
  state.phase = 'unauthenticated';
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

/**
 * Drops the profile view without touching the session or notifying anyone.
 *
 * Signing out clears this as part of ending the session, but an account can be
 * replaced without one — a Google callback adopting a second account in a tab
 * that already held a first. The profile left standing there is what tells the
 * router it need not ask the API who is signed in, so the new account would be
 * routed as the old one. No emit, because the caller is already inside the
 * change that prompted it.
 */
export function forgetAccount() {
  state.user = null;
  state.businesses = [];
  state.needsVerification = false;
}

/* One letter per session, whatever brought the account here.
 *
 * The password sign-up sent its own and Google's did not, so an account that
 * arrived through Google with an unconfirmed address never got asked to confirm
 * it — and a confirmed address is what binds staff invitations and links an
 * older account to a newer one. Doing it here rather than in either sign-in
 * path means it happens once, for every route in, including the ones added
 * later: this is the single place the app learns whether an address is
 * confirmed.
 *
 * Most Google accounts arrive already confirmed, because Google has done
 * exactly this check and says so in the token — nothing is sent then, and
 * sending anyway would be asking somebody to prove something we have just been
 * told. The letter goes to the accounts that genuinely have not confirmed. */
let verificationSent = false;

async function offerVerification() {
  if (verificationSent || !state.needsVerification || !accessToken()) return;
  verificationSent = true;
  try {
    await firebase.sendVerification(accessToken());
  } catch {
    /* Nobody is held at the door for this — the queue is already theirs and the
       reminder lives in a strip inside the dashboard. Let it fail quietly and
       let them press "send again" if they want it. */
    verificationSent = false;
  }
}

/** Called after any sign-in: our API supplies the profile and businesses. */
export function setAccount({ user, businesses }) {
  state.user = user;
  state.businesses = businesses;
  state.needsVerification = user ? user.emailVerified === false : false;
  emit();
  offerVerification();
}
