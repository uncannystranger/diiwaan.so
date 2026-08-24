/* Owner identity in the browser.

   Supabase Auth owns the credentials; this module speaks its REST API directly —
   six endpoints, no SDK bundle. The long-lived refresh token is handed straight
   to our backend, which seals it in an HttpOnly cookie, so no auth secret is ever
   written to localStorage and an XSS bug cannot walk off with a session. The tab
   keeps a short-lived access token in memory and renews it from the cookie on
   page load and shortly before it expires. */

import { t } from './i18n.js';

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
  backendError: ''
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
export const googleAuthAvailable = () => Boolean(runtime?.googleAuth);

/** Set when a provider sent us back with a refusal instead of a session. */
export let oauthError = '';

/* ---------- Supabase REST ---------- */

async function gotrue(path, { method = 'POST', body, token } = {}) {
  if (!runtime?.supabaseUrl || !runtime?.supabaseAnonKey) {
    throw new Error(state.backendError || 'The service is not reachable right now.');
  }

  const response = await fetch(`${runtime.supabaseUrl}/auth/v1${path}`, {
    method,
    headers: {
      apikey: runtime.supabaseAnonKey,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = new Error(friendly(data));
    /* The sentence is for the person; this is for the code that has to decide
       what to offer them next. */
    failure.reason = data?.error_code || data?.code || '';
    failure.status = response.status;
    throw failure;
  }
  return data;
}

/* Supabase answers in English. These are the handful a person actually meets,
   said in their own language — and each one names what to do next, not merely
   what went wrong. */
function friendly(error) {
  const message = error?.msg || error?.error_description || error?.message || '';
  const code = error?.error_code || error?.code || '';
  const is = pattern => pattern.test(message) || pattern.test(String(code));

  if (is(/invalid login credentials|invalid_credentials/i)) return t('auth.errWrongPair');
  if (is(/already registered|already exists|user_already_exists/i)) return t('auth.errTaken');
  if (is(/email not confirmed|email_not_confirmed/i)) return t('auth.errUnconfirmed');
  if (is(/password should be at least|weak_password|weak/i)) return t('auth.errWeak');
  if (is(/rate limit|too many|over_email_send_rate_limit|after \d+ seconds/i)) return t('auth.errTooMany');
  if (is(/invalid.*email|email address.*invalid|validation_failed/i)) return t('auth.errBadEmail');
  if (is(/signup.*disabled|signup_disabled/i)) return t('auth.errSignupOff');
  return message || t('common.wentWrong');
}

/** True when the only thing in the way is an email link nobody has clicked. */
export const isUnconfirmed = error => error?.reason === 'email_not_confirmed';

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
    if (!response.ok || !body.supabaseUrl || !body.supabaseAnonKey) {
      runtime = null;
      state.backendError = body?.detail || body?.error || `The service replied ${response.status}.`;
    } else {
      runtime = body;
      state.backendError = '';
    }
  } catch (error) {
    runtime = null;
    state.backendError = 'We could not reach the service. Check your connection and try again.';
  }

  // Confirmation, password-reset and provider redirects all come back with
  // their result in the fragment.
  const fragment = new URLSearchParams(location.hash.replace(/^#\/?/, '').split('?').pop());
  const linkRefresh = fragment.get('refresh_token');

  if (fragment.get('error')) {
    // A refusal at Google — a cancelled consent screen, or a provider that is
    // not configured. Say so on the sign-in screen instead of dropping the
    // person on the landing page with no explanation.
    oauthError = friendly({ msg: fragment.get('error_description') || fragment.get('error') });
    history.replaceState(null, '', `${location.pathname}#/signin`);
  }

  if (linkRefresh) {
    const type = fragment.get('type');
    await withDeadline(handOver(linkRefresh), 8000, 'timeout').catch(() => null);
    history.replaceState(null, '', `${location.pathname}#/${type === 'recovery' ? 'reset' : 'queue'}`);
  } else {
    /* A session restore that stalls must not hold the whole interface hostage:
       failing it simply means signed out, which is a state the app can render. */
    await withDeadline(restore(), 8000, 'timeout').catch(() => null);
  }

  state.ready = true;
  emit();
  return runtime;
}

/* ---------- credentials ---------- */

/* Where a confirmation or recovery link should land. GoTrue reads this from the
   query string, not the body — it was documented in a comment here but never
   actually sent, so every link fell back to the project's Site URL. It must also
   be listed under Authentication → URL Configuration, or GoTrue ignores it and
   falls back anyway. */
const linkBack = path => `redirect_to=${encodeURIComponent(`${appUrl()}/#/${path}`)}`;

export async function signUp({ email, password, name }) {
  const data = await gotrue(`/signup?${linkBack('queue')}`, {
    body: {
      email,
      password,
      data: { name },
      gotrue_meta_security: {}
    }
  });

  state.needsVerification = !data.access_token;
  if (data.refresh_token) await handOver(data.refresh_token);
  emit();
  return { needsVerification: state.needsVerification };
}

/**
 * Hands the browser to Supabase's provider flow. It returns to this app with a
 * refresh token in the fragment, which `boot()` already knows how to adopt — the
 * same path a confirmation link takes.
 */
export function startOAuth(provider = 'google') {
  if (!runtime) throw new Error('Not ready yet.');
  const back = new URL(appUrl());
  back.hash = '#/queue';
  const url = new URL(`${runtime.supabaseUrl}/auth/v1/authorize`);
  url.searchParams.set('provider', provider);
  url.searchParams.set('redirect_to', back.toString());
  location.assign(url.toString());
}

export async function signIn({ email, password }) {
  const data = await gotrue('/token?grant_type=password', { body: { email, password } });
  state.needsVerification = false;
  await handOver(data.refresh_token);
  return state.session;
}

/**
 * Signing out is local first: the tab forgets the session in the same tick as the
 * click, so the interface can move immediately. Revoking the cookie and the
 * Supabase token happens on the way out — the returned promise is there for
 * callers that want to know when it finished, not for the person leaving.
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
  await gotrue(`/recover?${linkBack('reset')}`, { body: { email } });
}

export async function resendVerification(email) {
  await gotrue(`/resend?${linkBack('queue')}`, { body: { type: 'signup', email } });
}

export async function updatePassword(password) {
  await gotrue('/user', { method: 'PUT', body: { password }, token: accessToken() });
}

/* ---------- branding uploads ---------- */

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

/**
 * Uploads branding art straight to Supabase Storage as the signed-in owner.
 * The bucket's policies only allow writes inside a folder named after that
 * owner's user id, so one business can never overwrite another's artwork.
 */
export async function uploadBrandingImage(file, { slug = 'logo' } = {}) {
  const id = userId();
  if (!id) throw new Error('Sign in again to upload an image.');
  const extension = EXTENSIONS[file.type];
  if (!extension) throw new Error('Use a PNG, JPEG, WebP or SVG image.');

  const bucket = runtime.brandingBucket || 'branding';
  const path = `${id}/${slug}-${Date.now()}.${extension}`;

  const response = await fetch(`${runtime.supabaseUrl}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      apikey: runtime.supabaseAnonKey,
      Authorization: `Bearer ${accessToken()}`,
      'Content-Type': file.type,
      'x-upsert': 'true',
      'cache-control': '31536000'
    },
    body: file
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(friendly(detail) || 'The image could not be uploaded.');
  }
  return `${runtime.supabaseUrl}/storage/v1/object/public/${bucket}/${path}`;
}

/** Called after any sign-in: our API supplies the profile and businesses. */
export function setAccount({ user, businesses }) {
  state.user = user;
  state.businesses = businesses;
  state.needsVerification = user ? user.emailVerified === false : false;
  emit();
}
