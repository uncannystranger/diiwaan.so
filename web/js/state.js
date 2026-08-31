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
/* Filed under the queue it belongs to. It held the customer's name and phone
   under one device-wide key, so only one offline join could exist at a time and
   nothing in the key said which business it was for. */
const PENDING_PREFIX = 'diiwaan:pending:';
const pendingKey = slug => `${PENDING_PREFIX}${slug}`;

const listeners = new Set();
export const subscribe = fn => (listeners.add(fn), () => listeners.delete(fn));
export const notify = () => listeners.forEach(fn => fn());

/* Which tenant the screen is on, as a number that only ever goes up.
 *
 * `owner` and `customer` are module singletons that a tenant switch mutates in
 * place, and a fetch started before the switch resolves after it. Every one of
 * these functions used to re-read `customer.slug` or `owner.business.id` after
 * its await — so the value it wrote under was whatever the singleton held when
 * the response happened to land, not the one it asked about. The last response
 * to arrive decided what rendered and what went into localStorage.
 *
 * That is how company A's business name, logo and queue ended up written to
 * `diiwaan:cache:public:company-b`, where every later scan of B's code read it
 * back before any network call. Persisted, so a reload did not help.
 *
 * So each context carries a generation. A switch bumps it; an async writer
 * captures it before awaiting and checks it after. A response from the previous
 * tenant is still parsed — it may be a perfectly good response — but it is not
 * allowed to write anything. It belongs to a screen nobody is looking at.
 *
 * The tenant key is captured the same way and used for the storage key, rather
 * than read again from the singleton. */
let ownerGeneration = 0;
let customerGeneration = 0;

/** True while the work started at `generation` still belongs to the current screen. */
const ownerCurrent = generation => generation === ownerGeneration;
const customerCurrent = generation => generation === customerGeneration;

const read = key => {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
};
const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
};

/* Two different people share this device's storage, and signing out concerns
   only one of them.

   The owner's keys hold a business the person was signed into: its details, its
   services, and the queue snapshot — which carries waiting customers by name.
   Leaving that behind meant an owner could sign out on a shared machine at the
   desk and leave their customer list readable in localStorage, for every
   business they had opened, indefinitely. Those keys go.

   The customer's keys are not the owner's to discard. A ticket token is the
   only proof that the person holding this phone is the one in position four; a
   remembered name saves them typing it again; the per-queue paint stops their
   next scan flashing the wrong brand. None of it belongs to whoever was signed
   in at the desk, and clearing it would eject real customers from real queues.

   Matching is by prefix rather than by a remembered list, so a key written
   somewhere this function has never heard of is still cleared. */
const OWNER_KEY = /^diiwaan:(business$|cache:(?!public:)|paint:owner$)/;

export function clearOwnerStorage() {
  try {
    Object.keys(localStorage)
      .filter(key => OWNER_KEY.test(key))
      .forEach(key => localStorage.removeItem(key));
  } catch { /* private mode: nothing was persisted to begin with */ }
}

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

/* Everything the desk held about one signed-in person, put back as it was
   before anyone signed in.
 *
 * This used to live inside the sign-out button's handler, which meant it only
 * ran when somebody clicked it. A session can end without a click — the renewal
 * timer calls signOut() when a refresh fails, and a revoked or expired cookie
 * ends the same way — and those paths left the previous owner's business, queue
 * snapshot and cached customer names sitting in memory and in localStorage for
 * whoever signed in next. Owning the teardown here, and driving it from the
 * identity change rather than from a control, is what makes "who is signed in"
 * and "whose data is on this device" the same question.
 *
 * The customer's own keys are deliberately untouched; clearOwnerStorage says
 * why. */
export function resetOwner() {
  closeStream();
  owner.loading = true;
  owner.error = null;
  owner.business = null;
  owner.businesses = [];
  owner.snapshot = null;
  owner.services = [];
  owner.members = [];
  owner.analytics = null;
  owner.membersLoading = false;
  owner.busy.clear();
  /* The freshness stamps are what let a reload skip a fetch. Left standing,
     they would let the next account read the previous one's answer. */
  analyticsAt = 0;
  membersAt = 0;
  clearTimeout(refreshTimer);
  clearOwnerStorage();
  notify();
}

/* ---------- owner ---------- */

let accountInFlight = null;

export async function loadAccount() {
  if (accountInFlight) return accountInFlight;
  owner.loading = true;
  notify();
  accountInFlight = (async () => {
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
      accountInFlight = null;
      notify();
    }
  })();
  return accountInFlight;
}

export async function openBusiness(businessId) {
  /* Opening a business is a tenant switch, so everything the previous one left
     on the desk goes now — not when its replacement happens to arrive. The
     derived screens are the ones that bit: their freshness stamps were only
     ever reset on sign-out, so switching businesses inside the TTL made
     loadAnalytics and loadMembers return without fetching, and B's Overview
     showed A's takings and B's Team screen showed A's staff. */
  const generation = ++ownerGeneration;
  owner.snapshot = null;
  owner.services = [];
  owner.members = [];
  owner.analytics = null;
  analyticsAt = 0;
  membersAt = 0;

  const cached = read(`${CACHE_PREFIX}${businessId}`);
  if (cached) {
    owner.business = cached.business;
    owner.snapshot = cached.snapshot;
    owner.services = cached.services || [];
  } else {
    owner.business = null;
  }
  owner.loading = !cached;
  notify();

  try {
    const [{ business }, snapshot, { services }] = await Promise.all([
      api.business(businessId),
      api.queue(businessId),
      api.services(businessId)
    ]);
    /* A second openBusiness overtook this one. Its business is the one on
       screen, and writing ours would put a different tenant's queue under it. */
    if (!ownerCurrent(generation)) return;
    owner.business = business;
    owner.snapshot = snapshot;
    owner.services = services;
    owner.error = null;
    write(`${CACHE_PREFIX}${businessId}`, { business, snapshot, services });
    startStream(businessId, generation);
  } catch (error) {
    if (!ownerCurrent(generation)) return;
    owner.error = error;
    if (error.offline) owner.connection = 'offline';
  } finally {
    if (ownerCurrent(generation)) {
      owner.loading = false;
      notify();
    }
  }
}

export async function refreshQueue({ silent = true } = {}) {
  if (!owner.business) return;
  const generation = ownerGeneration;
  const businessId = owner.business.id;
  try {
    const snapshot = await api.queue(businessId);
    if (!ownerCurrent(generation)) return;
    owner.snapshot = snapshot;
    owner.error = null;
    /* Keyed by the business this asked about. Re-reading the singleton here
       wrote one tenant's waiting customers, by name, into another's cache. */
    write(`${CACHE_PREFIX}${businessId}`, {
      business: owner.business, snapshot, services: owner.services
    });
  } catch (error) {
    if (!ownerCurrent(generation)) return;
    if (!silent) owner.error = error;
    if (error.offline) owner.connection = 'offline';
  } finally {
    if (ownerCurrent(generation)) notify();
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
  const generation = ownerGeneration;
  try {
    const analytics = await api.analytics(owner.business.id, params);
    if (!ownerCurrent(generation)) return;
    owner.analytics = analytics;
    analyticsAt = Date.now();
  } catch (error) {
    if (!ownerCurrent(generation)) return;
    owner.analytics = owner.analytics || null;
    if (error.offline) owner.connection = 'offline';
  } finally {
    if (ownerCurrent(generation)) notify();
  }
}

let membersAt = 0;

export async function loadMembers({ force = false } = {}) {
  if (!owner.business) return;
  if (!force && owner.members.length && Date.now() - membersAt < 30_000) return;
  const generation = ownerGeneration;
  owner.membersLoading = !owner.members.length;
  notify();
  try {
    const { members } = await api.members(owner.business.id);
    if (!ownerCurrent(generation)) return;
    owner.members = members;
    membersAt = Date.now();
  } catch { /* the screen shows its own empty state */ } finally {
    if (ownerCurrent(generation)) {
      owner.membersLoading = false;
      notify();
    }
  }
}

function startStream(businessId, generation = ownerGeneration) {
  disconnectStream?.();
  owner.connection = 'reconnecting';
  disconnectStream = connect(`/api/businesses/${businessId}/stream`, {
    authenticated: true,
    onStatus: status => {
      // A stream belonging to a business nobody is looking at says nothing.
      if (!ownerCurrent(generation)) return;
      owner.connection = status;
      notify();
      if (status === 'live') refreshQueue();
    },
    onEvent: () => {
      if (!ownerCurrent(generation)) return;
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
  const generation = ownerGeneration;
  const businessId = owner.business?.id;
  owner.busy.add(key);
  notify();
  try {
    const result = await fn();
    if (!ownerCurrent(generation)) return result;
    if (adopt && result?.snapshot) {
      owner.snapshot = result.snapshot;
      analyticsAt = 0;
      write(`${CACHE_PREFIX}${businessId}`, {
        business: owner.business, snapshot: result.snapshot, services: owner.services
      });
    } else {
      await refreshQueue();
    }
    return result;
  } catch (error) {
    if (!ownerCurrent(generation)) throw error;
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

/** Drops the held offline join for one queue. */
export const clearPendingJoin = (slug = customer.slug) => {
  localStorage.removeItem(pendingKey(slug));
  if (customer.slug === slug) { customer.pendingJoin = null; notify(); }
};

export async function openCustomer(slug) {
  /* Scanning a second business's code is a tenant switch, and nothing of the
     first one survives it.
   *
   * The view, the error and the pending join used to be left standing. On the
   * no-cache branch the screen still held the previous business, and the app's
   * "still loading" guard is `loading && !view` — false, because the view was
   * populated. So company A's ticket, queue position and name rendered at
   * company B's URL, A's palette was painted over B's page and then persisted
   * as B's remembered paint, and A's pending-join card offered to retry into a
   * queue the person was no longer looking at.
   *
   * The old stream is closed here rather than after the first fetch, because
   * it was outliving the switch: A's events kept firing refreshCustomer, which
   * by then was reading B's slug. */
  const generation = ++customerGeneration;
  closeCustomerStream();
  clearTimeout(customerTimer);

  customer.slug = slug;
  customer.token = ticketToken(slug);
  customer.view = null;
  customer.error = null;
  customer.pendingJoin = read(pendingKey(slug));
  customer.connection = 'idle';

  const cached = read(`${CACHE_PREFIX}public:${slug}`);
  customer.view = cached || null;
  customer.loading = !cached;
  notify();

  await refreshCustomer();
  if (!customerCurrent(generation)) return;
  startCustomerStream(slug, generation);
  flushPending();
}

export async function refreshCustomer() {
  if (!customer.slug) return;
  /* Both captured before the await. Everything below is written under the
     business this request actually asked about. */
  const generation = customerGeneration;
  const slug = customer.slug;
  try {
    const view = await api.publicView(slug, customer.token);
    if (!customerCurrent(generation)) return;
    view.at = new Date().toISOString();   // when this device last heard from the server
    customer.view = view;
    customer.error = null;
    customer.connection = customer.connection === 'offline' ? 'live' : customer.connection;

    /* A slug can be given up by one business and taken by another later — the
       unique index makes it unique at any moment, not over time. Everything
       this device remembers under that slug then belongs to the wrong company,
       so the identity is checked against the id the server just resolved and
       the stale entries are dropped rather than shown. */
    const previous = read(`${CACHE_PREFIX}public:${slug}`);
    if (previous?.business?.id && view.business?.id && previous.business.id !== view.business.id) {
      forgetCustomer(slug);
      clearTicketToken(slug);
      localStorage.removeItem(pendingKey(slug));
      localStorage.removeItem(`diiwaan:paint:q:${slug}`);
      customer.token = '';
      customer.pendingJoin = null;
    }

    write(`${CACHE_PREFIX}public:${slug}`, view);
    if (!view.ticket && customer.token) {
      // The desk finished or removed this ticket; stop claiming it.
      clearTicketToken(slug);
      customer.token = '';
    }
  } catch (error) {
    if (!customerCurrent(generation)) return;
    customer.error = error;
    if (error.offline) customer.connection = 'offline';
  } finally {
    if (customerCurrent(generation)) {
      customer.loading = false;
      notify();
    }
  }
}

let customerStream = null;
let customerTimer = null;

function startCustomerStream(slug, generation = customerGeneration) {
  customerStream?.();
  customerStream = connect(`/api/public/${encodeURIComponent(slug)}/stream`, {
    onStatus: status => {
      if (!customerCurrent(generation)) return;
      customer.connection = status;
      notify();
      if (status === 'live') refreshCustomer();
    },
    onEvent: () => {
      if (!customerCurrent(generation)) return;
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
  const generation = customerGeneration;
  try {
    const { token, view } = await api.join(slug, input);
    /* The ticket is this person's regardless of what they are looking at now,
       so it is always filed. Only the screen is left alone. */
    setTicketToken(slug, token);
    localStorage.removeItem(pendingKey(slug));
    if (!customerCurrent(generation)) return view;
    customer.token = token;
    customer.view = view;
    customer.pendingJoin = null;
    notify();
    return view;
  } catch (error) {
    if (error.offline) {
      // Safe to hold: the server has not issued a number, so nothing is claimed
      // until this replays. The screen says so rather than inventing a ticket.
      const held = { slug, input, at: Date.now() };
      write(pendingKey(slug), held);
      if (customer.slug === slug) { customer.pendingJoin = held; notify(); }
    }
    throw error;
  }
}

export async function flushPending() {
  const slug = customer.slug;
  const pending = customer.pendingJoin || read(pendingKey(slug));
  if (!pending || pending.slug !== slug || !navigator.onLine) return;
  const generation = customerGeneration;
  try {
    const { token, view } = await api.join(slug, pending.input);
    setTicketToken(slug, token);
    localStorage.removeItem(pendingKey(slug));
    if (!customerCurrent(generation)) return;
    customer.token = token;
    customer.view = view;
    customer.pendingJoin = null;
    notify();
  } catch {
    /* still offline or the queue closed — the pending card stays visible */
  }
}

export async function leaveQueue() {
  const generation = customerGeneration;
  const slug = customer.slug;
  const { view } = await api.leave(slug, customer.token);
  // The ticket that was given up is this one, whatever the screen moved on to.
  clearTicketToken(slug);
  if (!customerCurrent(generation)) return;
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
