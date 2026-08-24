/* Application state.

   The server is the authority. This module holds what the current screen needs,
   refreshes it when the realtime stream says something changed, and keeps a
   read-through cache so a reconnecting device shows the last known numbers
   instead of an empty screen. The cache is never treated as the truth: queue
   actions always go to the server, and a customer's offline join is held as a
   pending action until it can be replayed. */

import { api, ApiError } from './api.js';
import * as session from './session.js';
import { connect } from './realtime.js';

const CACHE_PREFIX = 'diiwaan:cache:';
const TICKET_PREFIX = 'diiwaan:ticket:';
const PENDING_KEY = 'diiwaan:pending';

const listeners = new Set();
export const subscribe = fn => (listeners.add(fn), () => listeners.delete(fn));
export const notify = () => listeners.forEach(fn => fn());

const read = key => {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
};
const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
};

export const owner = {
  loading: true,
  error: null,
  business: null,
  businesses: [],
  snapshot: null,
  services: [],
  members: [],
  analytics: null,
  membersLoading: false,
  connection: 'idle',   // idle | live | reconnecting | offline
  busy: new Set()
};

export const customer = {
  slug: '',
  loading: true,
  error: null,
  view: null,
  token: '',
  connection: 'idle',
  pendingJoin: null
};

let disconnectStream = null;
let refreshTimer = null;

/* ---------- owner ---------- */

export async function loadAccount() {
  owner.loading = true;
  notify();
  try {
    let { user, businesses } = await api.me();

    /* Someone who arrived through Google already told Google their name; asking
       again on the setup screen would be asking for something we were handed.
       Adopted once, the first time we see a profile that has none. */
    if (session.googleName && !user.name) {
      await api.updateProfile({ name: session.googleName }).catch(() => {});
      user = { ...user, name: session.googleName };
    }
    session.clearGoogleName();

    session.setAccount({ user, businesses });
    owner.businesses = businesses;
    owner.error = null;
    return { user, businesses };
  } catch (error) {
    owner.error = error;
    if (error.offline) owner.connection = 'offline';
    return { user: null, businesses: [] };
  } finally {
    owner.loading = false;
    notify();
  }
}

export async function openBusiness(businessId) {
  const cached = read(`${CACHE_PREFIX}${businessId}`);
  if (cached) {
    owner.business = cached.business;
    owner.snapshot = cached.snapshot;
    owner.services = cached.services || [];
    notify();
  }

  owner.loading = !cached;
  notify();

  try {
    const [{ business }, snapshot, { services }] = await Promise.all([
      api.business(businessId),
      api.queue(businessId),
      api.services(businessId)
    ]);
    owner.business = business;
    owner.snapshot = snapshot;
    owner.services = services;
    owner.error = null;
    write(`${CACHE_PREFIX}${businessId}`, { business, snapshot, services });
    startStream(businessId);
  } catch (error) {
    owner.error = error;
    if (error.offline) owner.connection = 'offline';
  } finally {
    owner.loading = false;
    notify();
  }
}

export async function refreshQueue({ silent = true } = {}) {
  if (!owner.business) return;
  try {
    const snapshot = await api.queue(owner.business.id);
    owner.snapshot = snapshot;
    owner.error = null;
    write(`${CACHE_PREFIX}${owner.business.id}`, {
      business: owner.business, snapshot, services: owner.services
    });
  } catch (error) {
    if (!silent) owner.error = error;
    if (error.offline) owner.connection = 'offline';
  } finally {
    notify();
  }
}

/* Analytics are expensive to compute and cheap to be a few seconds stale, so a
   burst of navigation between tabs reuses the last answer. The queue snapshot
   never gets this treatment. */
let analyticsAt = 0;
const ANALYTICS_TTL = 15_000;

export async function loadAnalytics(params = '', { force = false } = {}) {
  if (!owner.business) return;
  if (!force && owner.analytics && Date.now() - analyticsAt < ANALYTICS_TTL) return;
  try {
    owner.analytics = await api.analytics(owner.business.id, params);
    analyticsAt = Date.now();
  } catch (error) {
    owner.analytics = owner.analytics || null;
    if (error.offline) owner.connection = 'offline';
  } finally {
    notify();
  }
}

let membersAt = 0;

export async function loadMembers({ force = false } = {}) {
  if (!owner.business) return;
  if (!force && owner.members.length && Date.now() - membersAt < 30_000) return;
  owner.membersLoading = !owner.members.length;
  notify();
  try {
    const { members } = await api.members(owner.business.id);
    owner.members = members;
    membersAt = Date.now();
  } catch { /* the screen shows its own empty state */ } finally {
    owner.membersLoading = false;
    notify();
  }
}

function startStream(businessId) {
  disconnectStream?.();
  owner.connection = 'reconnecting';
  disconnectStream = connect(`/api/businesses/${businessId}/stream`, {
    authenticated: true,
    onStatus: status => {
      owner.connection = status;
      notify();
      if (status === 'live') refreshQueue();
    },
    onEvent: () => {
      // Events say "something moved"; the snapshot is re-read so ordering and
      // duplicate delivery cannot leave the desk showing a fiction. Anything
      // derived from it — today's numbers — is invalidated at the same time.
      analyticsAt = 0;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => refreshQueue(), 120);
    }
  });
}

export function closeStream() {
  disconnectStream?.();
  disconnectStream = null;
  owner.connection = 'idle';
}

/**
 * Runs a queue action with a busy flag and surfaces failures.
 * `adopt` takes the snapshot the endpoint already returned rather than spending
 * a second round trip asking for state the server just sent us.
 */
export async function act(key, fn, { onError, adopt = false } = {}) {
  owner.busy.add(key);
  notify();
  try {
    const result = await fn();
    if (adopt && result?.snapshot) {
      owner.snapshot = result.snapshot;
      analyticsAt = 0;
      write(`${CACHE_PREFIX}${owner.business.id}`, {
        business: owner.business, snapshot: result.snapshot, services: owner.services
      });
    } else {
      await refreshQueue();
    }
    return result;
  } catch (error) {
    if (onError) onError(error);
    else owner.error = error;
    notify();
    throw error;
  } finally {
    owner.busy.delete(key);
    notify();
  }
}

/* ---------- customer ---------- */

export const ticketToken = slug => read(`${TICKET_PREFIX}${slug}`) || '';
export const setTicketToken = (slug, token) => write(`${TICKET_PREFIX}${slug}`, token);
export const clearTicketToken = slug => localStorage.removeItem(`${TICKET_PREFIX}${slug}`);

/* ---------- knowing a returning customer ----------

   Filed under the queue it belongs to, so the barber never greets someone by the
   name they gave the pharmacy. Only the name is kept — never the phone, never
   the ticket history — and it lives on this device alone: nothing here is sent
   anywhere, and the customer can clear it from the page. */

const KNOWN_PREFIX = 'diiwaan:known:';

export const knownCustomer = slug => {
  const saved = read(`${KNOWN_PREFIX}${slug}`);
  return saved && typeof saved.name === 'string' ? saved.name : '';
};

export const rememberCustomer = (slug, name) => {
  const trimmed = String(name || '').trim().slice(0, 80);
  if (!trimmed) return;
  write(`${KNOWN_PREFIX}${slug}`, { name: trimmed });
};

export const forgetCustomer = slug => localStorage.removeItem(`${KNOWN_PREFIX}${slug}`);

export async function openCustomer(slug) {
  customer.slug = slug;
  customer.token = ticketToken(slug);
  const cached = read(`${CACHE_PREFIX}public:${slug}`);
  if (cached) {
    customer.view = cached;
    customer.loading = false;
    notify();
  } else {
    customer.loading = true;
    notify();
  }

  await refreshCustomer();
  startCustomerStream(slug);
  flushPending();
}

export async function refreshCustomer() {
  if (!customer.slug) return;
  try {
    const view = await api.publicView(customer.slug, customer.token);
    view.at = new Date().toISOString();   // when this device last heard from the server
    customer.view = view;
    customer.error = null;
    customer.connection = customer.connection === 'offline' ? 'live' : customer.connection;
    write(`${CACHE_PREFIX}public:${customer.slug}`, view);
    if (!view.ticket && customer.token) {
      // The desk finished or removed this ticket; stop claiming it.
      clearTicketToken(customer.slug);
      customer.token = '';
    }
  } catch (error) {
    customer.error = error;
    if (error.offline) customer.connection = 'offline';
  } finally {
    customer.loading = false;
    notify();
  }
}

let customerStream = null;
let customerTimer = null;

function startCustomerStream(slug) {
  customerStream?.();
  customerStream = connect(`/api/public/${encodeURIComponent(slug)}/stream`, {
    onStatus: status => {
      customer.connection = status;
      notify();
      if (status === 'live') refreshCustomer();
    },
    onEvent: () => {
      clearTimeout(customerTimer);
      customerTimer = setTimeout(() => refreshCustomer(), 150);
    }
  });
}

export function closeCustomerStream() {
  customerStream?.();
  customerStream = null;
}

export async function joinQueue(input) {
  const slug = customer.slug;
  try {
    const { token, view } = await api.join(slug, input);
    setTicketToken(slug, token);
    customer.token = token;
    customer.view = view;
    customer.pendingJoin = null;
    notify();
    return view;
  } catch (error) {
    if (error.offline) {
      // Safe to hold: the server has not issued a number, so nothing is claimed
      // until this replays. The screen says so rather than inventing a ticket.
      customer.pendingJoin = { slug, input, at: Date.now() };
      write(PENDING_KEY, customer.pendingJoin);
      notify();
    }
    throw error;
  }
}

export async function flushPending() {
  const pending = customer.pendingJoin || read(PENDING_KEY);
  if (!pending || pending.slug !== customer.slug || !navigator.onLine) return;
  try {
    const { token, view } = await api.join(pending.slug, pending.input);
    setTicketToken(pending.slug, token);
    customer.token = token;
    customer.view = view;
    customer.pendingJoin = null;
    localStorage.removeItem(PENDING_KEY);
    notify();
  } catch {
    /* still offline or the queue closed — the pending card stays visible */
  }
}

export async function leaveQueue() {
  const { view } = await api.leave(customer.slug, customer.token);
  clearTicketToken(customer.slug);
  customer.token = '';
  customer.view = view;
  notify();
}

window.addEventListener('online', () => {
  if (customer.slug) { customer.connection = 'reconnecting'; flushPending(); refreshCustomer(); }
  if (owner.business) { owner.connection = 'reconnecting'; refreshQueue(); }
  notify();
});
window.addEventListener('offline', () => {
  if (customer.slug) customer.connection = 'offline';
  if (owner.business) owner.connection = 'offline';
  notify();
});

export { ApiError };
