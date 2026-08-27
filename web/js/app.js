/* Routing, rendering and every control's action. */

import * as session from './session.js';
import * as store from './state.js';
import { api, ApiError } from './api.js';
import { cycleTheme, setTheme, retint, preference as themePreference } from './theme.js';
import { esc } from './ui.js';
import { prepareLogo, humanSize, MAX_INPUT_BYTES } from './image.js';
import { presetById, deriveFromPrimary, completeBranding, contrast, readableOn, paletteVars } from './palette.js';
import { enableAlerts, announce, holdScreenAwake, permission as notificationPermission } from './notify.js';
import { buzz } from './haptics.js';
import { t, toggleLanguage } from './i18n.js';
import { landingView, signUpView, signInView, forgotView, resetView } from './views/auth.js';
/* Only the entry screens are part of the first download. The console, the brand
   studio, the printed sign, the display and the customer page are each fetched
   the first time a route needs them — someone who opens the landing page and
   leaves never pays for the dashboard. */
const modules = new Map();
const lazy = path => {
  if (!modules.has(path)) modules.set(path, import(path));
  return modules.get(path);
};

const SCREEN_MODULES = {
  setup: './views/setup.js',
  queue: './views/console.js',
  overview: './views/console.js',
  brand: './views/brand.js',
  settings: './views/settings.js',
  sign: './views/sign.js',
  display: './views/display.js',
  customer: './views/customer.js'
};

/** Resolved modules, once loaded. screenFor stays synchronous. */
const screens = {};

async function loadScreen(kind) {
  const path = SCREEN_MODULES[kind];
  if (!path) return;
  Object.assign(screens, await lazy(path));
  // The console frame is shared by the sign and display screens.
  if (kind === 'sign' || kind === 'display' || kind === 'brand' || kind === 'settings') {
    Object.assign(screens, await lazy('./views/console.js'));
  }
}

const root = document.getElementById('app');

const ui = {
  auth: { name: '', email: '', password: '', errors: {} },
  showPassword: false,
  resetSent: false,
  verifyDismissed: false,
  googleBusy: false,
  busy: false,
  saving: false,
  setup: { step: 0, errors: {}, slugPreview: '' },
  setupResumed: false,
  services: [],
  search: '',
  add: { name: '', phone: '', serviceId: '', error: '' },
  addOpen: false,
  accountOpen: false,
  signingOut: false,
  settingsSection: 'business',
  previewTab: 'join',
  displayIdle: false,
  qrWarning: '',
  contrastWarning: '',
  join: { name: '', phone: '', serviceId: '', errors: {} },
  greeted: false,
  notifyOn: false,
  notifyMode: '',
  toasts: [],
  dialog: null,
  busySet: new Set()
};

let lastValues = new Map();
let lastScreenKey = '';
let lastRenderedKey = '';
let lastHtml = '';
let booted = false;
let lastOverlayKey = '';
const scrollMemory = new Map();
let toastId = 0;
let lastAnnounced = null;
let saveTimer = null;
let renderQueued = false;

/* ---------- toasts and dialogs (no browser alert boxes) ---------- */

function dismissToast(id) {
  ui.toasts = ui.toasts.filter(item => item.id !== id);
  render();
}

function toast(message, { variant = '', action, timeout = 3200 } = {}) {
  const id = ++toastId;
  ui.toasts.push({ id, message, variant, action });
  render();
  if (timeout) {
    setTimeout(() => {
      ui.toasts = ui.toasts.filter(t => t.id !== id);
      render();
    }, timeout);
  }
  return id;
}

/* Labels default through t(), not through English string literals — a dialog
   that opens in the wrong language is the one place a bilingual interface most
   obviously falls apart. */
function dialog({ title, body, confirmLabel, cancelLabel, danger = false, fields = [] }) {
  confirmLabel = confirmLabel || t('common.confirm');
  cancelLabel = cancelLabel || t('common.cancel');
  return new Promise(resolve => {
    ui.dialog = { title, body, confirmLabel, cancelLabel, danger, fields, values: {}, resolve };
    render();
    requestAnimationFrame(() => {
      const target = root.querySelector('[data-dialog-field]') || root.querySelector('[data-trap] .btn');
      target?.focus();
    });
  });
}

const confirmDialog = options => dialog({ ...options, confirmLabel: options.confirmLabel || t('common.yesDoIt') });

function closeDialog(result) {
  const pending = ui.dialog;
  ui.dialog = null;
  render();
  pending?.resolve(result);
}

function dialogMarkup() {
  const d = ui.dialog;
  if (!d) return '';
  return `
  <div class="scrim" data-action="dialog-cancel" role="dialog" aria-modal="true"
       aria-label="${esc(d.title)}" ${d.body ? 'aria-describedby="dialog-body"' : ''}>
    <form class="sheet sheet--dialog" data-action="dialog-confirm" data-trap>
      <div class="sheet__grip"></div>
      <h2>${esc(d.title)}</h2>
      ${d.body ? `<p class="lead mt-8" id="dialog-body">${esc(d.body)}</p>` : ''}
      ${d.fields.length ? `
        <div class="stack gap-16 mt-24">
          ${d.fields.map((field, index) => `
            <div class="field">
              <label for="dlg-${index}">${esc(field.label)}</label>
              <input id="dlg-${index}" data-dialog-field="${esc(field.name)}" data-keep="dlg-${index}"
                     type="${field.type || 'text'}" value="${esc(d.values[field.name] ?? field.value ?? '')}"
                     placeholder="${esc(field.placeholder || '')}" />
            </div>`).join('')}
        </div>` : ''}
      <div class="btn-row mt-24">
        <button type="button" class="btn btn--quiet" data-action="dialog-cancel-btn">${esc(d.cancelLabel)}</button>
        <button type="submit" class="btn ${d.danger ? 'btn--danger' : ''}" style="flex:2 1 180px">${esc(d.confirmLabel)}</button>
      </div>
    </form>
  </div>`;
}

const toastMarkup = () => ui.toasts.length ? `
  <div class="toast-stack" role="status" aria-live="polite">
    ${ui.toasts.map(t => `
      <div class="toast ${t.variant ? `toast--${t.variant}` : ''}">
        ${esc(t.message)}
        ${t.action ? `<span class="toast__action" data-action="toast-action" data-id="${t.id}">${esc(t.action.label)}</span>` : ''}
      </div>`).join('')}
  </div>` : '';

/* ---------- routing ---------- */

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  if (hash) {
    const [name, param] = hash.split('/');
    return { name: name || '', param: param || '' };
  }
  // Deep links such as /j/hodan-clinic arrive as a real path.
  const [, name = '', param = ''] = location.pathname.split('/');
  return { name, param };
}

const CONSOLE_ROUTES = ['queue', 'overview', 'brand', 'settings', 'sign', 'display'];
const AUTH_ROUTES = { signup: signUpView, signin: signInView, forgot: forgotView, reset: resetView };

let currentSlug = '';
let currentBusinessId = '';

async function resolveRoute() {
  const route = parseRoute();

  if (route.name === 'j' || route.name === 't') {
    if (route.param && route.param !== currentSlug) {
      currentSlug = route.param;
      store.closeStream();
      await store.openCustomer(route.param);
    }
    return { kind: 'customer' };
  }

  currentSlug = '';
  store.closeCustomerStream();

  /* An unconfirmed address no longer stops anyone. Firebase issues a working
     session immediately, so the queue opens now and the reminder to confirm
     lives in a strip inside the dashboard — a wall here would hold somebody at
     the door of a product that is already theirs. */

  if (!session.isSignedIn()) {
    return { kind: AUTH_ROUTES[route.name] ? route.name : 'landing' };
  }

  if (!session.state.user) await store.loadAccount();

  const businesses = store.owner.businesses;
  if (!businesses.length) return { kind: 'setup' };

  // An account can hold more than one business: prefer the one this device was
  // last using, then the first that finished setup, and only then the newest.
  const remembered = localStorage.getItem('diiwaan:business');
  const business = businesses.find(b => b.id === remembered)
    || businesses.find(b => b.onboarded)
    || businesses[0];
  localStorage.setItem('diiwaan:business', business.id);
  if (business.id !== currentBusinessId) {
    currentBusinessId = business.id;
    try {
      await store.openBusiness(business.id);
    } catch (error) {
      /* The remembered business can be one this account no longer has — deleted
         from another device, or left behind by a test. Forget it and fall back
         to any other, rather than leaving the console on a spinner forever. */
      localStorage.removeItem('diiwaan:business');
      const fallback = businesses.find(b => b.id !== business.id);
      if (!fallback) throw error;
      currentBusinessId = fallback.id;
      localStorage.setItem('diiwaan:business', fallback.id);
      await store.openBusiness(fallback.id);
    }
    loadAuxiliary();
    alignPresetColours();
  }
  if (store.owner.business && !store.owner.business.onboarded) {
    // Resume where the owner left off rather than asking for the name again.
    if (!ui.setupResumed) {
      ui.setup.step = store.owner.business.name ? 1 : 0;
      ui.setupResumed = true;
    }
    return { kind: 'setup' };
  }

  return { kind: CONSOLE_ROUTES.includes(route.name) ? route.name : 'queue' };
}

/* A business that chose a preset stores the five colours that preset had at the
   time. The interface now resolves those from the preset id, but the server
   still hands its stored copy to the printed report and the QR, so a refreshed
   preset would show two different palettes. This writes the resolved set back
   once, the first time an owner opens a business whose stored colours have
   fallen behind. Businesses with their own colours are never touched. */
async function alignPresetColours() {
  const business = store.owner.business;
  const branding = business?.branding;
  const preset = branding && presetById(branding.preset);
  if (!preset) return;
  if (branding.primary === preset.primary && branding.tint === preset.tint) return;

  try {
    const { business: updated } = await api.updateBranding(business.id, {
      primary: preset.primary, emphasis: preset.emphasis,
      accent: preset.accent, base: preset.base, tint: preset.tint
    });
    await refreshBusiness(updated);
  } catch { /* the interface already shows the right colours either way */ }
}

async function loadAuxiliary() {
  await Promise.all([store.loadAnalytics(), store.loadMembers()]);
  ui.services = store.owner.services;
}

/* ---------- rendering ---------- */

const joinBase = () => session.appUrl() || location.origin;

function consoleContext() {
  return {
    business: store.owner.business,
    snapshot: store.owner.snapshot,
    services: store.owner.services,
    members: store.owner.members,
    membersLoading: store.owner.membersLoading,
    analytics: store.owner.analytics,
    user: session.state.user,
    role: store.owner.business?.role || 'owner',
    connection: store.owner.connection,
    loading: store.owner.loading,
    error: store.owner.error,
    busy: store.owner.busy,
    joinBase: joinBase()
  };
}

function screenFor(resolved) {
  switch (resolved.kind) {
    case 'landing': return landingView(ui);
    case 'signup': case 'signin': case 'forgot': case 'reset':
      return AUTH_ROUTES[resolved.kind](ui);
    case 'setup': return screens.setupView({ ...ui, services: store.owner.services }, store.owner.business, joinBase());
    case 'customer': return customerScreen();
    default: {
      const ctx = consoleContext();
      if (!ctx.business) return screens.customerLoading ? screens.customerLoading() : '';
      /* `ui.busy` is the boolean a form uses for its own submit; the queue's
         in-flight actions are a Set and travel in the context. They used to
         share this one name, and assigning the Set here left every submit
         button permanently disabled. */
      const context = { ...ctx, busy: store.owner.busy };
      if (resolved.kind === 'overview') return screens.overviewView(ui, context);
      if (resolved.kind === 'brand') return screens.brandView({ ...ui, services: store.owner.services }, context);
      if (resolved.kind === 'settings') return screens.settingsView(ui, context);
      if (resolved.kind === 'sign') return screens.signView(ui, context);
      if (resolved.kind === 'display') return screens.displayView(ui, context);
      return screens.queueView(ui, context);
    }
  }
}

function customerScreen() {
  const { view, loading, error, connection, pendingJoin } = store.customer;
  if (loading && !view) return screens.customerLoading();
  if (!view) return screens.customerErrorView(error || new ApiError(404, 'We could not find that queue.'));

  const context = { view, connection, error };
  if (pendingJoin) return screens.pendingView(ui, context);
  if (!view.ticket) {
    const wasHolding = parseRoute().name === 't';
    return wasHolding ? screens.doneView(ui, context) : screens.joinView(ui, context);
  }
  return screens.ticketView(ui, context);
}

/* The active brand is painted onto the document root, so every derived token —
   the page ground, the ink ramp, borders, fields, shadows, the wash — comes from
   the same five colours. Previews still carry their own palette locally. */
let paintedBrand = '';

/* Which palette the page is allowed to use.
 *
 *   entry     Diiwaan's own front door — landing, sign in, sign up, reset.
 *             Navy and white, and nothing else. It is not a business's page and
 *             it is not the desk, so it borrows neither one's colours.
 *   app       the dashboard and the customer's queue, where a business's own
 *             five colours belong.
 *
 * Set on the root element rather than a wrapper, because every semantic token
 * is derived from the five seeds with color-mix at :root. A seed overridden
 * further down the tree would not recompute anything — the derived values are
 * already computed by then — so the scope has to live where the derivation does. */
const ENTRY_KINDS = new Set(['landing', 'signup', 'signin', 'forgot', 'reset']);

function applyScope(resolved) {
  const scope = ENTRY_KINDS.has(resolved.kind) ? 'entry' : 'app';
  const root = document.documentElement;
  if (root.dataset.scope === scope) return;
  retint(() => { root.dataset.scope = scope; });
}

/* The Google SDK is fetched while a sign-in screen sits idle, so that pressing
   the button opens a popup inside the gesture that asked for one rather than
   after a quarter-megabyte download. Only these screens carry the button, so
   nobody else pays for it. Once, and never on a screen without it. */
let googleWarmed = false;
function warmGoogleFor(resolved) {
  if (googleWarmed || !ENTRY_KINDS.has(resolved.kind)) return;
  if (!session.googleAuthAvailable()) return;
  googleWarmed = true;
  const warm = () => session.warmGoogle();
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 2000 });
  else setTimeout(warm, 300);
}

function applyBrand(resolved) {
  /* A business's palette is never painted onto Diiwaan's own front door. */
  if (ENTRY_KINDS.has(resolved.kind)) {
    const root = document.documentElement;
    if (paintedBrand !== null) {
      paintedBrand = null;
      retint(() => {
        root.removeAttribute('style');
        root.dataset.surface = '';
        root.dataset.brand = '';
      });
    }
    return;
  }

  const branding = resolved.kind === 'customer'
    ? store.customer.view?.business?.branding
    : store.owner.business?.branding;

  const brand = completeBranding(branding || {});
  const signature = `${brand.primary}|${brand.emphasis}|${brand.accent}|${brand.base}|${brand.tint}|${brand.surface}`;
  if (signature === paintedBrand) return;
  paintedBrand = signature;

  const style = paletteVars(brand);
  retint(() => {
    const root = document.documentElement;
    for (const declaration of style.split(';')) {
      const [name, value] = declaration.split(':');
      root.style.setProperty(name.trim(), value.trim());
    }
    root.dataset.surface = brand.surface;
    root.dataset.brand = '';
  });

  // Remembered so the next load paints these colours before the first frame
  // instead of flashing the default palette while the account loads. Only a real
  // business's palette is worth caching — the signed-out screens fall back to the
  // house colours, and storing those would reintroduce the flash.
  if (branding) {
    try {
      const key = resolved.kind === 'customer' ? `q:${store.customer.slug}` : 'owner';
      localStorage.setItem(`diiwaan:paint:${key}`, JSON.stringify({ style, surface: brand.surface }));
    } catch { /* private mode: the paint simply is not remembered */ }
  }
}

function applyCustomerTheme(resolved) {
  const branding = store.customer.view?.business?.branding;
  const forced = resolved.kind === 'customer' && branding && branding.theme !== 'system' ? branding.theme : null;
  if (forced) {
    retint(() => { document.documentElement.dataset.theme = forced; });
    document.documentElement.dataset.forced = forced;
  } else if (document.documentElement.dataset.forced) {
    document.documentElement.dataset.forced = '';
    setTheme(themePreference);
  }
}

let resolvedRoute = { kind: 'landing' };

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

/** Moves the pressed state between chips without rebuilding anything around them. */
function markChosen(action, chosenId) {
  root.querySelectorAll(`[data-action="${action}"]`).forEach(chip => {
    chip.setAttribute('aria-pressed', String(chip.dataset.id === chosenId));
  });
}

/* Writing the new screen in.

   Moving between console sections does not rebuild the application: the header,
   the navigation and the footer stay exactly where they are, and only the
   section between them is exchanged. That is what removes the flash — there is
   never a moment where the shell is missing and the browser has nothing to
   paint but its own background.

   A full replace is kept for genuine screen changes: signing in, arriving on a
   customer page, opening the display. */
const parser = document.createElement('div');

function commit(html, sectionChanged, done) {
  const current = root.querySelector('#main');

  if (sectionChanged && current) {
    parser.innerHTML = html;
    const next = parser.querySelector('#main');
    const nextChrome = parser.querySelector('.topbar');
    const nextNav = parser.querySelector('.mobile-nav');

    if (next) {
      // The chrome is updated in place — the same nodes, new attributes — so the
      // sticky header never unmounts and the page never loses its background.
      const chrome = root.querySelector('.topbar');
      if (chrome && nextChrome) chrome.innerHTML = nextChrome.innerHTML;
      const nav = root.querySelector('.mobile-nav');
      if (nav && nextNav) nav.innerHTML = nextNav.innerHTML;

      swapSection(current, next);
      syncOverlays(parser);
      done();
      return;
    }
  }

  root.innerHTML = html;
  done();
}

/* The section itself crossfades: the outgoing content is held for a moment
   under the incoming one, so there is no gap between them. */
function swapSection(current, next) {
  if (reduceMotion.matches) {
    current.replaceWith(next);
    return;
  }
  next.classList.add('section-enter');
  current.replaceWith(next);
  requestAnimationFrame(() => {
    next.classList.add('section-enter--in');
    next.addEventListener('transitionend', () => {
      next.classList.remove('section-enter', 'section-enter--in');
    }, { once: true });
  });
}

/* Dialogs, sheets and toasts live beside the screen rather than inside the
   section, so they are reconciled separately. */
function syncOverlays(source) {
  const keep = new Set();
  source.querySelectorAll(':scope > .scrim, :scope > .toast-stack').forEach(node => keep.add(node.className));

  root.querySelectorAll(':scope > .scrim, :scope > .toast-stack').forEach(node => {
    if (!keep.has(node.className)) node.remove();
  });
  source.querySelectorAll(':scope > .scrim, :scope > .toast-stack').forEach(node => {
    const existing = root.querySelector(`:scope > .${node.className.split(' ').join('.')}`);
    if (existing) existing.innerHTML = node.innerHTML;
    else root.append(node.cloneNode(true));
  });
}

function render() {
  /* Two gates, and both are needed.

     `booted` says a route has been resolved at least once. `phase` says
     identity is settled. A render that passes the first but not the second
     would be drawing a screen chosen from an auth state that is still a guess,
     which is exactly how a dashboard appears for a moment and is then taken
     away again. Until both hold, the honest thing to show is the splash already
     in the document. */
  if (!booted || session.isInitializing()) return;

  const active = document.activeElement;
  const keep = active?.dataset?.keep;
  const caret = keep && 'selectionStart' in active ? active.selectionStart : null;

  applyScope(resolvedRoute);
  warmGoogleFor(resolvedRoute);
  applyCustomerTheme(resolvedRoute);
  applyBrand(resolvedRoute);
  if (resolvedRoute.kind === 'customer') greetArrival();

  // Entrance motion belongs to arriving on a screen, not to every refresh:
  // without this the 30-second tick would replay the whole page animation.
  const screenKey = `${resolvedRoute.kind}:${store.customer.slug || store.owner.business?.id || ''}`;
  const sameScreen = screenKey === lastScreenKey;
  root.dataset.noAnim = sameScreen ? '1' : '';

  /* Moving between console sections is a different move from arriving: the
     chrome stays put and only the section beneath it changes, so only that part
     animates. Every other re-render — a queue tick, a store update — must not
     animate at all or the desk would flicker all day. */
  const sectionChanged = !sameScreen && lastScreenKey !== '';
  lastScreenKey = screenKey;

  // Each section keeps its own scroll position, so coming back to the queue
  // does not throw you at the top of a list you were reading.
  if (sectionChanged) scrollMemory.set(lastRenderedKey, window.scrollY);

  /* Which overlay is on screen, if any. An overlay that was already open before
     this render keeps its position: only a newly opened one animates in. */
  const overlayKey = ui.dialog ? `dialog:${ui.dialog.title}`
    : ui.addOpen ? 'add'
      : ui.accountOpen ? 'account'
        : '';
  const overlaySettled = overlayKey !== '' && overlayKey === lastOverlayKey;
  lastOverlayKey = overlayKey;

  const html = screenFor(resolvedRoute) + dialogMarkup() + toastMarkup();

  /* A tick that changes nothing should touch nothing. The queue re-renders on
     every SSE event and every 30-second tick; rewriting an identical DOM threw
     away focus, scroll and any in-flight CSS transition for no reason, which is
     what the section changes looked like they were doing. */
  if (html === lastHtml && !sectionChanged) return;
  lastHtml = html;

  root.dataset.overlaySettled = overlaySettled ? '1' : '';

  /* Everything that reads or touches the new DOM has to wait for it to exist:
     with a view transition the write happens inside a callback, not inline. */
  commit(html, sectionChanged, () => afterWrite({ sectionChanged, screenKey, keep, caret }));
}

function afterWrite({ sectionChanged, screenKey, keep, caret }) {
  if (sectionChanged) {
    const main = root.querySelector('#main');
    if (main) {
      main.classList.add('section-in');
      main.addEventListener('animationend', () => main.classList.remove('section-in'), { once: true });
    }
    window.scrollTo({ top: scrollMemory.get(screenKey) || 0, behavior: 'instant' });
  }
  lastRenderedKey = screenKey;
  markScrolled();

  if (keep) {
    const next = root.querySelector(`[data-keep="${keep}"]`);
    if (next && next !== document.activeElement) {
      next.focus({ preventScroll: true });
      if (caret !== null && 'setSelectionRange' in next) {
        try { next.setSelectionRange(caret, caret); } catch { /* not a text input */ }
      }
    }
  }

  const seen = new Map();
  root.querySelectorAll('[data-anim-key]').forEach(el => {
    const key = el.dataset.animKey;
    const value = el.textContent.trim();
    seen.set(key, value);
    if (lastValues.has(key) && lastValues.get(key) !== value) {
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
    }
  });
  lastValues = seen;

  scalePreviews();
  if (resolvedRoute.kind === 'customer') announceTurn();
}

/** The brand preview renders at true phone width, then scales to its frame. */
function scalePreviews() {
  root.querySelectorAll('.device').forEach(device => {
    const inner = device.querySelector('.device__scale');
    if (inner) inner.style.transform = `scale(${device.clientWidth / 390})`;
  });
}
window.addEventListener('resize', scalePreviews);

async function navigate() {
  /* Nothing may be resolved from an identity that is still being established.
     Boot calls navigate() itself once it has finished, so an early call here —
     a hashchange arriving mid-boot, say — is dropped rather than answered with
     a guess that would have to be corrected a moment later. */
  if (session.isInitializing()) return;

  const next = await resolveRoute();
  // The screen's module is fetched before it is rendered, so render() stays
  // synchronous and never paints a half-loaded view.
  await loadScreen(next.kind);
  resolvedRoute = next;
  canonicalise(next);
  render();
}

/* The address bar has to agree with the screen.

   Routing here is a resolution, not a lookup: asking for '#/' while signed in
   resolves to the queue, and asking for '#/queue' before a business exists
   resolves to setup. When the URL is left saying something the screen is not,
   the next thing to read it disagrees with what is on display — the back
   button, a link to the route you are already on, a reload — and the app
   appears to bounce between two pages.

   replaceState rather than pushState: this is the same navigation, corrected,
   not a new one. Adding a history entry would make Back undo the correction and
   land straight back on the wrong URL. */
function canonicalise(route) {
  // Customer routes are real paths carrying a slug; they are already canonical.
  if (route.kind === 'customer') return;

  const target = `#/${route.kind === 'landing' ? '' : route.kind}`;
  if (location.hash === target) return;
  // A bare '/' with no hash is a legitimate spelling of the landing route.
  if (target === '#/' && (location.hash === '' || location.hash === '#')) return;

  history.replaceState(null, '', `${location.pathname}${location.search}${target}`);
}

/* Renders are coalesced to one per frame. A hidden tab never gets a frame, so a
   timer runs alongside the animation frame and whichever arrives first does the
   render — otherwise a dashboard left in a background tab latches the flag and
   never repaints again, even after you come back to it. */
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    renderQueued = false;
    render();
  };
  requestAnimationFrame(run);
  setTimeout(run, 100);
}

store.subscribe(scheduleRender);
/* Everything on this screen that belonged to the person who was signed in.
 *
 * store.resetOwner() forgets the business, the queue and the cached copies of
 * both. This forgets the rest: the half-typed forms, the search box, the tab
 * somebody was on, the setup wizard's position — all of it filled in by one
 * account and none of it the next account's to inherit. Without this, signing
 * out of A and into B on the same device left B looking at A's customer search,
 * A's service editor and A's setup step.
 *
 * The route bookkeeping goes too, because it is what decides whether work needs
 * doing at all: currentBusinessId is compared against the business the next
 * account resolves to, and left standing it can match — the same person signing
 * back in, or a shared business — and skip the load that would have refilled
 * the state we just emptied. */
function forgetTenant() {
  session.forgetAccount();
  store.resetOwner();
  store.closeCustomerStream();
  currentBusinessId = '';
  currentSlug = '';
  scrollMemory.clear();

  ui.auth = { name: '', email: '', password: '', errors: {} };
  ui.showPassword = false;
  ui.resetSent = false;
  ui.verifyDismissed = false;
  ui.googleBusy = false;
  ui.busy = false;
  ui.saving = false;
  ui.setup = { step: 0, errors: {}, slugPreview: '' };
  ui.setupResumed = false;
  ui.services = [];
  ui.search = '';
  ui.add = { name: '', phone: '', serviceId: '', error: '' };
  ui.addOpen = false;
  ui.accountOpen = false;
  ui.settingsSection = 'business';
  ui.previewTab = 'join';
  ui.qrWarning = '';
  ui.contrastWarning = '';
  ui.dialog = null;
  ui.busySet.clear();
}

/* Signing in or out changes which screen belongs on the page, so it has to
   re-resolve the route and not merely repaint the one already chosen.
 *
 * Repainting was the bug behind the landing page that would not go away. A
 * session restore slower than boot's deadline finished after the router had
 * already settled on `landing`; adopt() flipped the phase to authenticated and
 * emitted, this listener repainted — with the same stale route — and the owner
 * sat on the public page holding a valid session until they happened to click
 * something that called navigate().
 *
 * Only a change is a routing event. Every other emit — a renewed token, a
 * profile arriving — is a repaint, which is what it was always meant to be. */
/* Identity is tracked by who, not merely by whether. Signing out of one account
   and into another can settle before this listener runs twice — and a boolean
   that reads true both times would call it no change, leaving the first
   account's desk on screen for the second. */
let lastUserId = null;
let sawSession = false;
let reroutePending = false;

session.onSessionChange(() => {
  const userId = session.userId();
  const changed = sawSession && userId !== lastUserId;
  const previous = lastUserId;
  lastUserId = userId;
  sawSession = true;

  /* Anything the previous account left behind goes before the next screen is
     resolved, so nothing of theirs can be painted while B's own data loads. */
  if (changed && previous !== null) forgetTenant();

  if (!booted || !changed) return render();
  // Several emits can land in one tick; one re-resolve answers all of them.
  if (reroutePending) return;
  reroutePending = true;
  queueMicrotask(() => { reroutePending = false; navigate(); });
});

/* The display's controls belong to whoever is setting it up, not to the room.
   After a few still seconds they fade; any movement brings them back. */
let idleTimer = null;
function watchDisplayIdle() {
  const wake = () => {
    if (ui.displayIdle) { ui.displayIdle = false; render(); }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (resolvedRoute.kind !== 'display') return;
      ui.displayIdle = true;
      render();
    }, 4000);
  };
  ['pointermove', 'keydown', 'touchstart'].forEach(type =>
    window.addEventListener(type, wake, { passive: true }));
  wake();
}
watchDisplayIdle();

/* Marks the screen once anything has scrolled under the header, so the header
   can draw its edge only when there is something to separate it from. */
function markScrolled() {
  const screen = root.querySelector('.screen');
  if (!screen) return;
  const scrolled = window.scrollY > 4 ? '1' : '';
  if (screen.dataset.scrolled !== scrolled) screen.dataset.scrolled = scrolled;
}
window.addEventListener('scroll', markScrolled, { passive: true });

/* ---------- customer alerts ---------- */

/* Asked for once, silently, on the back of the join tap. A refusal is not an
   error state: the page still shows the turn, so nothing is broken by it. */
async function autoEnableAlerts() {
  if (ui.notifyOn) return;
  if (notificationPermission() === 'denied' || notificationPermission() === 'unsupported') return;

  try {
    const view = store.customer.view;
    const result = await enableAlerts({
      slug: store.customer.slug,
      token: store.customer.token,
      publicKey: view?.push?.publicKey || ''
    });
    if (!result.ok) return;
    ui.notifyOn = true;
    ui.notifyMode = result.reason;
    render();
  } catch { /* the queue matters more than the notification */ }
}

let arrivalGreeted = '';
function greetArrival() {
  const slug = store.customer.slug;
  if (!slug || arrivalGreeted === slug) return;
  arrivalGreeted = slug;
  buzz('select');

  // A returning customer starts with their name already in the field, so the
  // whole journey is: scan, one tap, done.
  const known = store.knownCustomer(slug);
  if (known && !ui.join.name) {
    ui.join = { ...ui.join, name: known };
    ui.greeted = true;
  }
}

function announceTurn() {
  const view = store.customer.view;
  const ticket = view?.ticket;
  // Holding a ticket keeps the screen awake; letting it go releases the lock.
  holdScreenAwake(Boolean(ticket) && ticket.status !== 'completed');
  if (!ticket) return;

  const stage = ticket.status !== 'waiting' ? 'called' : ticket.ahead <= 1 ? 'soon' : null;
  if (!stage || stage === lastAnnounced) {
    if (!stage) lastAnnounced = null;
    return;
  }
  lastAnnounced = stage;

  // The visual state is always shown; sound and vibration only once the customer
  // has asked for alerts.
  if (!ui.notifyOn) return;
  announce({
    title: view.business.name,
    body: stage === 'called'
      ? `${ticket.label} — it is your turn. Please come to the desk.`
      : `${ticket.label} — you are nearly up.`,
    called: stage === 'called'
  });
}

/* ---------- helpers ---------- */

const business = () => store.owner.business;

function reportError(error, fallback = 'That did not work.') {
  const message = error instanceof ApiError ? error.message : fallback;
  toast(message, { variant: error?.offline ? 'warn' : 'alert', timeout: 4200 });
}

/** Saves owner edits without a Save button, but not on every keystroke. */
function scheduleSave(fn) {
  clearTimeout(saveTimer);
  ui.saving = true;
  render();
  // Just long enough to coalesce a burst of keystrokes; short enough that the
  // "Saved" pill lands while the person is still looking at the field.
  saveTimer = setTimeout(async () => {
    try {
      await fn();
    } catch (error) {
      reportError(error, t('err.notSaved'));
    } finally {
      ui.saving = false;
      render();
    }
  }, 160);
}

async function refreshBusiness(updated) {
  store.owner.business = updated;
  store.owner.businesses = store.owner.businesses.map(b => (b.id === updated.id ? { ...b, ...updated } : b));
  store.notify();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const currentQrSvg = async (size = 1024) => {
  const { qrSvg } = await lazy('./qr.js');
  const b = business();
  const qr = b.qrSettings;
  return qrSvg(`${joinBase()}/j/${b.slug}`, {
    size, shape: qr.shape, dark: qr.foreground, light: qr.background,
    eye: qr.eyeColor || qr.foreground, logo: qr.logoOnCode ? b.logo : '',
    quiet: qr.quietZone, level: qr.errorCorrection
  });
};

/* A QR can be customised into something a phone struggles with; check contrast
   and quiet zone before the owner prints a thousand of them. */
function checkQrReadability(qr) {
  const luminance = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  try {
    const light = luminance(qr.background);
    const dark = luminance(qr.foreground);
    const contrast = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
    if (contrast < 4) return 'These colours are too close — scanners will struggle. Darken the code or lighten the background.';
    if (dark > light) return 'A light code on a dark background does not scan on most phones. Swap the two colours.';
    if (qr.quietZone < 4) return 'Keep at least four modules of quiet space around the code.';
  } catch { /* colour was mid-edit */ }
  return '';
}

/* ---------- actions ---------- */

const actions = {
  /* Theme: one attribute write, icon swapped in place, nothing else. Silent by
     design — a confirmation for a change you can already see is just noise. */
  'cycle-theme'() {
    cycleTheme();
  },

  /* dialogs and toasts */
  'dialog-cancel'(event, el) { if (event.target === el) closeDialog(null); },
  'dialog-cancel-btn'() { closeDialog(null); },
  'dialog-confirm'(event, form) {
    event.preventDefault();
    const values = {};
    form.querySelectorAll('[data-dialog-field]').forEach(input => { values[input.dataset.dialogField] = input.value; });
    closeDialog(ui.dialog?.fields.length ? values : true);
  },
  'toast-action'(event, el) {
    const found = ui.toasts.find(t => String(t.id) === el.dataset.id);
    found?.action?.run?.();
    ui.toasts = ui.toasts.filter(t => String(t.id) !== el.dataset.id);
    render();
  },
  'close-scrim'(event, el) {
    if (event.target !== el) return;
    ui.addOpen = false;
    ui.accountOpen = false;
    render();
  },

  /* authentication */
  async 'sign-up'(event, form) {
    event.preventDefault();
    const { name, email, password } = readAuthForm(form);
    ui.auth.errors = validateAuth({ name, email, password });
    if (Object.keys(ui.auth.errors).length) return render();
    ui.busy = true; render();
    try {
      await session.signUp({ email, password, name });
      await store.loadAccount();
      if (session.state.user) await api.updateProfile({ name });
      location.hash = '#/setup';
      toast(t('msg.accountCreated'));
    } catch (error) {
      ui.auth.errors = { form: error.message };
    } finally {
      ui.busy = false;
      await navigate();
    }
  },
  async 'sign-in'(event, form) {
    event.preventDefault();
    const { email, password } = readAuthForm(form);
    ui.auth.errors = {};
    if (!email || !password) {
      ui.auth.errors = { form: t('auth.needBoth') };
      return render();
    }
    ui.busy = true; render();
    try {
      await session.signIn({ email, password });
      await store.loadAccount();
      ui.auth = { name: '', email: '', password: '', errors: {} };
      location.hash = '#/queue';
      toast(t('msg.welcomeBack'));
    } catch (error) {
      /* An account that exists but was never confirmed is not a wrong password —
         it is one unclicked link. The screen that can resend it is more use than
         an error above a form they filled in correctly. */
      ui.auth.errors = { form: error.message };
    } finally {
      ui.busy = false;
      await navigate();
    }
  },
  async 'send-reset'(event, form) {
    event.preventDefault();
    const email = form.querySelector('#fp-email').value.trim();
    ui.auth.email = email;
    if (!email) { ui.auth.errors = { email: t('auth.needEmail') }; return render(); }
    ui.busy = true; render();
    try {
      await session.sendReset(email);
      ui.resetSent = true;
    } catch (error) {
      ui.auth.errors = { form: error.message };
    } finally {
      ui.busy = false; render();
    }
  },
  async 'set-password'(event, form) {
    event.preventDefault();
    const password = form.querySelector('#np-password').value;
    if (password.length < 8) { ui.auth.errors = { password: t('auth.needLonger') }; return render(); }
    ui.busy = true; render();
    try {
      await session.updatePassword(password);
      toast(t('msg.passwordUpdated'));
      location.hash = '#/queue';
    } catch (error) {
      ui.auth.errors = { form: error.message };
    } finally {
      ui.busy = false;
      await navigate();
    }
  },
  async 'send-reset-signed-in'() {
    try {
      await session.sendReset(session.state.user.email);
      toast(t('msg.resetSent'));
    } catch (error) { reportError(error); }
  },
  async 'resend-verification'() {
    ui.busy = true; render();
    try {
      await session.resendVerification();
      toast(t('msg.confirmResent'));
    } catch (error) { reportError(error); } finally { ui.busy = false; render(); }
  },
  async 'check-verification'() {
    ui.busy = true; render();
    try {
      const verified = await session.refreshVerification();
      if (!verified) return toast(t('msg.notConfirmed'), { variant: 'warn' });
      await store.loadAccount();
      toast(t('msg.emailConfirmed'), { variant: 'good' });
    } catch (error) {
      reportError(error);
    } finally { ui.busy = false; render(); }
  },
  /* Dismissing hides the strip for this tab only. The address is still
     unconfirmed and the reminder returns next visit — it is a nudge, not a
     decision, so it must not be possible to switch it off for good by accident. */
  'dismiss-verify'() { ui.verifyDismissed = true; render(); },
  /* The page is about to be replaced by Google's, so the button is put into its
     going state and left there — there is no "after" in this tab to reset it. */
  /* The page is about to be replaced by Google's, so the button goes into its
     going state and stays there — there is no "after" in this tab to reset it.
     The guard is what stops a second press starting a second authorisation and
     discarding the first. */
  async 'google-auth'() {
    if (ui.googleBusy) return;
    ui.googleBusy = true;
    ui.auth.errors = {};
    render();
    try {
      const session_ = await session.startGoogle();
      /* A popup that completed leaves us signed in without ever going
         anywhere, so this tab has to move itself. Null means the browser
         refused the popup and the page is already on its way to Google. */
      if (session_) {
        ui.googleBusy = false;
        await navigate();
      }
    } catch (error) {
      // We never left, so the button has to come back.
      ui.googleBusy = false;
      /* Closing the Google window is not a failure to report back. */
      if (!error?.cancelled) ui.auth.errors = { form: error.message };
      render();
    }
  },
  'toggle-password'() { ui.showPassword = !ui.showPassword; render(); },
  /* Signing out is local work: drop the session and the cached tenant state and
     move. Revoking the cookie server-side happens on the way out rather than
     being something the person waits for. */
  'sign-out'() {
    if (ui.signingOut) return;          // a second click must not queue a second exit
    ui.signingOut = true;

    ui.accountOpen = false;
    const done = session.signOut();     // fire and forget; the cookie clears regardless
    /* The teardown itself is not done here. session.signOut() changes who is
       signed in, and forgetTenant() hangs off that change — so the same clearing
       happens whether the session ended at this button or at a refresh token
       that would not renew. */
    location.hash = '#/';
    navigate();
    done.finally(() => { ui.signingOut = false; });
  },
  'account-menu'() { ui.accountOpen = true; render(); },

  /* setup */
  async 'setup-business'(event, form) {
    event.preventDefault();
    const values = {};
    form.querySelectorAll('[data-setup]').forEach(input => { values[input.dataset.setup] = input.value.trim(); });
    if (!values.name || values.name.length < 2) {
      ui.setup.errors = { name: 'Give your business a name.' };
      return render();
    }
    ui.setup.errors = {};
    ui.busy = true; render();
    try {
      if (business()) {
        const { business: updated } = await api.updateBusiness(business().id, values);
        await refreshBusiness(updated);
      } else {
        const { business: created } = await api.createBusiness(values);
        store.owner.businesses = [created, ...store.owner.businesses];
        currentBusinessId = created.id;
        await store.openBusiness(created.id);
      }
      ui.setup.step = 1;
    } catch (error) {
      reportError(error, t('err.couldNotSave'));
    } finally {
      ui.busy = false; render();
    }
  },
  async 'setup-prefix'(event, el) {
    ui.setup.prefix = el.dataset.value;
    try {
      await api.updateQueue(business().id, { prefix: el.dataset.value });
      await store.refreshQueue();
    } catch (error) { reportError(error); }
    render();
  },
  async 'setup-queue'() {
    ui.busy = true; render();
    try {
      if (ui.setup.avgServiceMin) await api.updateQueue(business().id, { avgServiceMin: Number(ui.setup.avgServiceMin) });
      await store.refreshQueue();
      ui.setup.step = 2;
    } catch (error) { reportError(error); } finally { ui.busy = false; render(); }
  },
  'setup-next'() { ui.setup.step = Math.min(3, ui.setup.step + 1); render(); },
  async 'setup-finish'() {
    ui.busy = true; render();
    try {
      const { business: updated } = await api.finishOnboarding(business().id);
      await refreshBusiness(updated);
      ui.setup = { step: 0, errors: {}, slugPreview: '' };
      location.hash = '#/queue';
      toast(t('msg.queueLive'));
    } catch (error) { reportError(error); } finally {
      ui.busy = false;
      await navigate();
    }
  },

  /* queue */
  async 'queue-next'() {
    try {
      const result = await store.act('next', () => api.next(business().id), { adopt: true });
      toast(t('msg.nowServing', { label: result.ticket.label, name: result.ticket.name }));
    } catch (error) {
      if (error.status === 409) toast(t('msg.noOneWaiting'), { variant: 'warn' });
      else reportError(error);
    }
  },
  async 'queue-recall'() {
    try {
      const { ticket } = await store.act('recall', () => api.recall(business().id));
      toast(t('msg.callingAgain', { label: ticket.label }));
    } catch (error) { reportError(error); }
  },
  /* The one control that decides whether a scanned QR can put anyone in the
     queue. Turning it off pauses the queue, which the server enforces on join —
     the switch is not merely a label on the dashboard. */
  async 'toggle-live'() {
    const snapshot = store.owner.snapshot;
    const status = snapshot?.queue?.status;
    const next = status === 'open' ? 'paused' : 'open';
    try {
      await store.act('live', () => api.queueStatus(business().id, next), { adopt: true });
      toast(t(next === 'open' ? 'live.on' : 'live.off'));
    } catch (error) { reportError(error); }
  },

  /* The greeting is a convenience, never a lock-in: one tap drops the saved
     name and returns an empty form. */
  'forget-me'() {
    store.forgetCustomer(store.customer.slug);
    ui.join = { ...ui.join, name: '', errors: {} };
    ui.greeted = false;
    render();
    toast(t('cust.forgotten'));
  },

  /* Signing out is one tap from the header, but never by accident: a shift ends
     with someone's queue still on screen. */
  async 'sign-out-confirm'() {
    const ok = await confirmDialog({
      title: t('ask.signOutTitle'),
      body: t('ask.signOutBody'),
      confirmLabel: t('con.signOut')
    });
    if (ok) actions['sign-out']();
  },

  /* Opening the display in its own window is what makes this a second screen
     rather than a page the cashier has to leave. The dashboard keeps running in
     this window; the new one is a plain route, so it shares the same session and
     the same live queue. */
  'open-display'() {
    const url = `${location.origin}${location.pathname}#/display`;
    const opened = window.open(url, 'diiwaan-display', 'noopener,width=1280,height=800');
    if (!opened) {
      // A blocked popup should not be a dead end.
      toast(t('display.blocked'), { variant: 'warn', timeout: 5000 });
      location.hash = '#/display';
    }
  },

  async 'display-fullscreen'() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { /* the browser or the OS refused; the view still fills the window */ }
  },

  'toggle-language'() {
    toggleLanguage();
    render();
  },

  async 'queue-pause'() {
    const snapshot = store.owner.snapshot;
    const next = snapshot.queue.status === 'paused' ? 'open' : 'paused';
    try {
      await store.act('pause', () => api.queueStatus(business().id, next), { adopt: true });
      toast(t(next === 'paused' ? 'msg.queueOffNow' : 'msg.queueLive'));
    } catch (error) { reportError(error); }
  },
  async 'queue-status'(event, el) {
    const status = el.dataset.value;
    if (status === 'closed') {
      const ok = await confirmDialog({
        title: t('ask.closeTitle'),
        body: t('ask.closeBody'),
        confirmLabel: t('ask.closeConfirm'),
        danger: true
      });
      if (!ok) return;
    }
    try {
      await store.act('status', () => api.queueStatus(business().id, status), { adopt: true });
      toast(t(status === 'open' ? 'msg.queueLive' : status === 'paused' ? 'msg.queueOffNow' : 'act.queue_closed'));
    } catch (error) { reportError(error); }
  },
  'close-queue-today'(event, el) { actions['queue-status'](event, { dataset: { value: 'closed' } }); },

  'open-add'() { ui.addOpen = true; ui.add = { name: '', phone: '', serviceId: '', error: '' }; render(); },
  'close-add'() { ui.addOpen = false; render(); },
  /* Choosing a service changes one attribute on one chip. Re-rendering the whole
     screen for that rebuilt the sheet from scratch and restarted its entrance
     animation, which is what made the popup jump. */
  'pick-add-service'(event, el) {
    ui.add.serviceId = ui.add.serviceId === el.dataset.id ? '' : el.dataset.id;
    markChosen('pick-add-service', ui.add.serviceId);
  },
  async 'add-customer'(event, form) {
    event.preventDefault();
    const name = form.querySelector('#add-name').value.trim();
    if (!name) { ui.add.error = 'Please add a name.'; return render(); }
    ui.busy = true; render();
    try {
      const { ticket } = await api.addTicket(business().id, {
        name, phone: form.querySelector('#add-phone')?.value.trim() || '', serviceId: ui.add.serviceId || null
      });
      ui.addOpen = false;
      await store.refreshQueue();
      toast(t('msg.added', { label: ticket.label, name: ticket.name }));
    } catch (error) { reportError(error, t('err.customerNotAdded')); } finally { ui.busy = false; render(); }
  },

  async 'ticket-skip'() {
    const serving = store.owner.snapshot?.serving;
    if (!serving) return;
    try {
      await store.act('skip', () => api.ticketAction(business().id, serving.id, 'skip'));
      toast(t('msg.movedToEnd', { label: serving.label }), { variant: 'warn' });
    } catch (error) { reportError(error); }
  },
  async 'ticket-serving'(event, el) {
    try {
      await store.act('serving', () => api.ticketAction(business().id, el.dataset.id, 'serving'));
      toast(t('msg.serviceStarted'));
    } catch (error) { reportError(error); }
  },
  async 'ticket-complete'(event, el) {
    try {
      await store.act('complete', () => api.ticketAction(business().id, el.dataset.id, 'close', { status: 'completed' }));
      toast(t('msg.customerCompleted'));
    } catch (error) { reportError(error); }
  },
  async 'ticket-noshow'(event, el) {
    try {
      await store.act('noshow', () => api.ticketAction(business().id, el.dataset.id, 'close', { status: 'no_show' }));
      toast(t('msg.markedNoShow'), { variant: 'warn' });
    } catch (error) { reportError(error); }
  },
  async 'ticket-call'(event, el) {
    const label = el.dataset.label;
    try {
      await store.act(`call-${el.dataset.id}`, () => api.ticketAction(business().id, el.dataset.id, 'call'), { adopt: true });
      toast(t('msg.callingNow', { label }));
    } catch (error) {
      if (error.status === 409) toast(error.message, { variant: 'warn' });
      else reportError(error);
    }
  },
  async 'ticket-move'(event, el) {
    try {
      await store.act(`move-${el.dataset.id}`, () =>
        api.ticketAction(business().id, el.dataset.id, 'move', { direction: el.dataset.value }));
    } catch (error) { reportError(error); }
  },
  async 'ticket-remove'(event, el) {
    const label = el.dataset.label;
    const ok = await confirmDialog({
      title: t('ask.removeTitle', { label }),
      body: t('ask.removeBody'),
      confirmLabel: t('ask.remove'),
      danger: true
    });
    if (!ok) return;
    try {
      await store.act(`remove-${el.dataset.id}`, () =>
        api.ticketAction(business().id, el.dataset.id, 'close', { status: 'cancelled' }));
      toast(t('msg.removed', { label }), { variant: 'warn' });
    } catch (error) { reportError(error); }
  },

  /* brand */
  /* One preset is five colours and their identity, saved together so the whole
     token system moves at once rather than a colour at a time. */
  async 'apply-preset'(event, el) {
    const preset = presetById(el.dataset.id);
    if (!preset) return;
    try {
      const { business: updated } = await api.updateBranding(business().id, {
        preset: preset.id,
        primary: preset.primary,
        emphasis: preset.emphasis,
        accent: preset.accent,
        base: preset.base,
        tint: preset.tint
      });
      await refreshBusiness(updated);
      ui.contrastWarning = '';
      toast(t('msg.presetApplied', { name: preset.name }), { timeout: 1600 });
    } catch (error) { reportError(error); }
  },

  /* Custom colours stay a set: the other four are rebuilt around the primary. */
  async 'derive-palette'() {
    const derived = deriveFromPrimary(completeBranding(business().branding).primary);
    try {
      const { business: updated } = await api.updateBranding(business().id, { ...derived, preset: '' });
      await refreshBusiness(updated);
      ui.contrastWarning = '';
      toast(t('msg.paletteRebuilt'));
    } catch (error) { reportError(error); }
  },
  'brand-surface': brandSetter(el => ({ surface: el.dataset.value })),
  'brand-theme': brandSetter(el => ({ theme: el.dataset.value })),
  'qr-shape': qrSetter(el => ({ shape: el.dataset.value })),
  'qr-level': qrSetter(el => ({ errorCorrection: el.dataset.value })),
  async 'toggle-qr-logo'() {
    const qr = business().qrSettings;
    await saveQr({ logoOnCode: !qr.logoOnCode, ...(qr.logoOnCode ? {} : { errorCorrection: 'H' }) });
  },
  'display-layout': qrSetter(el => ({ displayLayout: el.dataset.value })),
  async 'toggle-display-serving'() { await saveQr({ displayShowServing: business().qrSettings.displayShowServing === false }); },
  async 'toggle-display-waiting'() { await saveQr({ displayShowWaiting: business().qrSettings.displayShowWaiting === false }); },
  async 'toggle-display-next'() { await saveQr({ displayShowNext: business().qrSettings.displayShowNext === false }); },
  'toggle-phone': pageToggle('requirePhone'),
  'toggle-service': pageToggle('askService'),
  'toggle-ahead': pageToggle('showPeopleAhead'),
  'toggle-estimate': pageToggle('showEstimate'),
  'toggle-progress': pageToggle('showProgress'),
  'preview-tab'(event, el) { ui.previewTab = el.dataset.value; render(); },
  async 'clear-logo'() {
    try {
      const { business: updated } = await api.updateBranding(business().id, { logo: '' });
      await refreshBusiness(await api.updateBusiness(business().id, { logo: '' }).then(r => r.business) || updated);
      toast(t('msg.logoRemoved'));
    } catch (error) { reportError(error); }
  },
  async 'save-slug'() {
    const input = root.querySelector('[data-keep="b-slug"], [data-keep="set-slug"]');
    const slug = input?.value.trim();
    if (!slug || slug === business().slug) return;
    const ok = await confirmDialog({
      title: t('ask.linkTitle'),
      body: t('ask.linkBody', { slug }),
      confirmLabel: t('ask.linkConfirm')
    });
    if (!ok) return;
    try {
      const { business: updated } = await api.updateBusiness(business().id, { slug });
      await refreshBusiness(updated);
      toast(t('msg.linkChanged'));
    } catch (error) { reportError(error, t('err.linkTaken')); }
  },
  'copy-link'() {
    const url = `${joinBase()}/j/${business().slug}`;
    navigator.clipboard.writeText(url)
      .then(() => toast(t('msg.linkCopied')))
      .catch(() => toast(t('msg.copyFailed'), { variant: 'warn' }));
  },
  async 'download-qr'(event, el) {
    const b = business();
    const svg = await currentQrSvg(1024);
    const filename = `${b.slug}-qr`;
    if (el.dataset.value === 'svg') {
      downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${filename}.svg`);
      return toast(t('msg.qrSvg'));
    }
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1024;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, 1024, 1024);
      canvas.toBlob(blob => {
        downloadBlob(blob, `${filename}.png`);
        toast(t('msg.qrPng'));
      }, 'image/png');
    };
    image.onerror = () => toast(t('msg.qrPngFailed'), { variant: 'warn' });
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  },
  /* The report endpoint is authorised, so it cannot be a plain link: the file is
     fetched with the session's token and handed to the browser as a download. */
  async 'download-report'(event, el) {
    const period = el.dataset.value || 'today';
    const id = toast(t('msg.preparingReport'), { timeout: 0 });
    try {
      const response = await fetch(api.reportUrl(business().id, `?period=${period}`), {
        headers: { Authorization: `Bearer ${session.accessToken()}` }
      });
      if (!response.ok) throw new ApiError(response.status, 'That report could not be generated.');
      const blob = await response.blob();
      downloadBlob(blob, `${business().slug}-queue-report-${period}.pdf`);
      dismissToast(id);
      toast(t('msg.reportDownloaded'));
    } catch (error) {
      dismissToast(id);
      reportError(error, t('err.reportFailed'));
    }
  },

  print() { window.print(); },

  /* settings */
  'settings-section'(event, el) { ui.settingsSection = el.dataset.value; render(); },
  async 'set-prefix'(event, el) {
    try {
      await api.updateQueue(business().id, { prefix: el.dataset.value });
      await store.refreshQueue();
      toast(t('msg.prefixChanged', { value: el.dataset.value }));
    } catch (error) { reportError(error); }
  },
  async 'add-service'() {
    const values = await dialog({
      title: t('ask.addServiceTitle'),
      body: t('ask.addServiceBody'),
      confirmLabel: t('ask.addServiceConfirm'),
      fields: [
        { name: 'name', label: t('ask.serviceName'), placeholder: t('ask.serviceNamePlaceholder') },
        { name: 'estimatedDuration', label: t('ask.serviceLength'), type: 'number', value: '10' }
      ]
    });
    if (!values?.name) return;
    try {
      await api.createService(business().id, {
        name: values.name.trim(),
        estimatedDuration: Math.max(1, Number(values.estimatedDuration) || 10)
      });
      const { services } = await api.services(business().id);
      store.owner.services = services;
      ui.services = services;
      toast(t('msg.serviceAdded'));
      store.notify();
    } catch (error) { reportError(error, t('err.serviceNotAdded')); }
  },
  async 'delete-service'(event, el) {
    const ok = await confirmDialog({
      title: t('ask.deleteServiceTitle', { label: el.dataset.label || t('ask.thisService') }),
      body: t('ask.deleteServiceBody'),
      confirmLabel: t('ask.delete'),
      danger: true
    });
    if (!ok) return;
    try {
      await api.deleteService(business().id, el.dataset.id);
      const { services } = await api.services(business().id);
      store.owner.services = services;
      ui.services = services;
      toast(t('msg.serviceDeleted'));
      store.notify();
    } catch (error) { reportError(error); }
  },
  async 'toggle-service-active'(event, el) {
    const service = store.owner.services.find(s => s.id === el.dataset.id);
    try {
      await api.updateService(business().id, el.dataset.id, { active: service.active === false });
      const { services } = await api.services(business().id);
      store.owner.services = services;
      store.notify();
    } catch (error) { reportError(error); }
  },
  async 'invite-member'() {
    const values = await dialog({
      title: t('ask.inviteTitle'),
      body: t('ask.inviteBody'),
      confirmLabel: t('ask.inviteConfirm'),
      fields: [
        { name: 'name', label: t('ask.inviteName'), placeholder: t('ask.inviteNamePlaceholder') },
        { name: 'email', label: t('ask.inviteEmail'), type: 'email', placeholder: 'name@example.com' }
      ]
    });
    if (!values?.email) return;
    try {
      await api.inviteMember(business().id, { email: values.email.trim(), name: values.name?.trim() || '', role: 'staff' });
      await store.loadMembers();
      toast(t('msg.inviteReady', { email: values.email.trim() }), { timeout: 5000 });
    } catch (error) { reportError(error, t('err.inviteNotSent')); }
  },
  async 'member-role'(event, el) {
    try {
      await api.updateMember(business().id, el.dataset.id, { role: el.dataset.value });
      await store.loadMembers();
      toast(t('msg.roleUpdated'));
    } catch (error) { reportError(error); }
  },
  async 'member-status'(event, el) {
    const member = store.owner.members.find(m => m.id === el.dataset.id);
    try {
      await api.updateMember(business().id, el.dataset.id, { status: member.status === 'active' ? 'disabled' : 'active' });
      await store.loadMembers();
    } catch (error) { reportError(error); }
  },
  async 'member-remove'(event, el) {
    const ok = await confirmDialog({
      title: t('ask.removeTitle', { label: el.dataset.label }),
      body: t('ask.removeMemberBody'),
      confirmLabel: t('ask.remove'),
      danger: true
    });
    if (!ok) return;
    try {
      await api.removeMember(business().id, el.dataset.id);
      await store.loadMembers();
      toast(t('msg.memberRemoved'));
    } catch (error) { reportError(error); }
  },

  /* customer */
  'pick-service'(event, el) {
    ui.join.serviceId = ui.join.serviceId === el.dataset.id ? '' : el.dataset.id;
    markChosen('pick-service', ui.join.serviceId);
  },
  async 'join-queue'(event, form) {
    event.preventDefault();
    const name = form.querySelector('#join-name').value.trim();
    const phone = form.querySelector('#join-phone').value.trim();
    // Carried to the server, which decides what they mean.
    const company = form.querySelector('#join-company')?.value || '';
    const elapsed = Date.now() - Number(form.dataset.shown || Date.now());
    const view = store.customer.view;
    ui.join = { ...ui.join, name, phone, errors: {} };

    if (!name) ui.join.errors.name = 'Please tell us your name.';
    if (view.business.experience.requirePhone && !phone) ui.join.errors.phone = 'A phone number is needed so we can call you.';
    if (Object.keys(ui.join.errors).length) return render();

    ui.busy = true; render();
    try {
      const result = await store.joinQueue({ name, phone, serviceId: ui.join.serviceId || null, company, elapsed });
      // This device now knows who joins at this queue, and only this queue.
      store.rememberCustomer(store.customer.slug, name);
      ui.join = { name: '', phone: '', serviceId: '', errors: {} };
      lastAnnounced = null;
      history.replaceState(null, '', `#/t/${store.customer.slug}`);
      toast(t('msg.youAreInQueue', { label: result.ticket.label }));
      // Browsers only allow a permission prompt while a gesture is still in
      // effect, and joining is that gesture. If it is refused or unavailable the
      // join stands regardless — the button on the ticket remains the way back.
      autoEnableAlerts();
    } catch (error) {
      if (error.offline) toast(t('msg.savedOffline'), { variant: 'warn' });
      else if (error.status === 409) ui.join.errors.form = error.message;
      else if (error.status === 422) ui.join.errors.form = error.message;
      else reportError(error);
    } finally {
      ui.busy = false;
      await navigate();
    }
  },
  async 'leave-queue'() {
    const ok = await confirmDialog({
      title: t('ask.leaveTitle'),
      body: t('ask.leaveBody'),
      confirmLabel: t('ask.leaveConfirm'),
      danger: true
    });
    if (!ok) return;
    try {
      await store.leaveQueue();
      history.replaceState(null, '', `#/j/${store.customer.slug}`);
      toast(t('msg.youLeft'), { variant: 'warn' });
      await navigate();
    } catch (error) { reportError(error); }
  },
  async rejoin() {
    store.clearTicketToken(store.customer.slug);
    store.customer.token = '';
    history.replaceState(null, '', `#/j/${store.customer.slug}`);
    await store.refreshCustomer();
    await navigate();
  },
  async 'retry-join'() {
    await store.flushPending();
    if (store.customer.pendingJoin) toast(t('msg.stillOffline'), { variant: 'warn' });
    else { toast('You are in the queue'); history.replaceState(null, '', `#/t/${store.customer.slug}`); }
    await navigate();
  },
  'cancel-pending'() {
    // The one belonging to the queue on screen, not whichever was held last.
    store.clearPendingJoin();
    render();
  },
  async notify() {
    if (ui.notifyOn) {
      ui.notifyOn = false;
      render();
      return toast(t('msg.alertsOff'));
    }

    const view = store.customer.view;
    const result = await enableAlerts({
      slug: store.customer.slug,
      token: store.customer.token,
      publicKey: view?.push?.publicKey || ''
    });

    if (!result.ok) {
      ui.notifyOn = false;
      render();
      return toast(
        t(result.reason === 'denied' ? 'msg.alertsBlocked' : 'msg.alertsDeclined'),
        { variant: 'warn', timeout: 5200 }
      );
    }

    ui.notifyOn = true;
    ui.notifyMode = result.reason;
    render();
    toast(
      t(result.reason === 'push' ? 'msg.alertsPush' : 'msg.alertsLocal'),
      { timeout: 4600 }
    );
  },
  'reload-customer'() { store.refreshCustomer(); },
  'reload-queue'() { store.refreshQueue({ silent: false }); }
};

function brandSetter(pick) {
  return async (event, el) => {
    try {
      const { business: updated } = await api.updateBranding(business().id, pick(el));
      await refreshBusiness(updated);
    } catch (error) { reportError(error); }
  };
}

function qrSetter(pick) {
  return async (event, el) => { await saveQr(pick(el)); };
}

async function saveQr(patch) {
  try {
    const merged = { ...business().qrSettings, ...patch };
    ui.qrWarning = checkQrReadability(merged);
    const { business: updated } = await api.updateQr(business().id, patch);
    await refreshBusiness(updated);
  } catch (error) { reportError(error); }
}

/* A hand-picked colour is still checked: the owner is told when a choice costs
   legibility, rather than discovering it on a customer's phone. */
function saveBrandColour(role, value) {
  const brand = { ...completeBranding(business().branding), [role]: value };
  const checks = [
    [contrast(brand.primary, readableOn(brand.primary)), 'the text on your primary buttons'],
    [contrast(brand.emphasis, brand.base), 'your body text on light surfaces']
  ];
  const weak = checks.find(([ratio]) => ratio < 4.5);
  ui.contrastWarning = weak ? `That leaves ${weak[1]} hard to read. Try a deeper or lighter shade.` : '';

  return scheduleSave(async () => {
    const { business: updated } = await api.updateBranding(business().id, { [role]: value, preset: '' });
    await refreshBusiness(updated);
  });
}

function pageToggle(field) {
  return async () => {
    try {
      const { business: updated } = await api.updateExperience(business().id, { [field]: !business().customerExperience[field] });
      await refreshBusiness(updated);
    } catch (error) { reportError(error); }
  };
}

function readAuthForm(form) {
  const value = id => form.querySelector(`#${id}`)?.value.trim() || '';
  return {
    name: value('su-name'),
    email: value('su-email') || value('si-email'),
    password: form.querySelector('#su-password')?.value || form.querySelector('#si-password')?.value || ''
  };
}

function validateAuth({ name, email, password }) {
  const errors = {};
  if (!name || name.length < 2) errors.name = t('auth.needName');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = t('auth.errBadEmail');
  if (!password || password.length < 8) errors.password = t('auth.needLonger');
  else if (!/[0-9]/.test(password) || !/[a-zA-Z]/.test(password)) errors.password = t('auth.needMix');
  return errors;
}

/* ---------- event wiring ---------- */

/* How a press should feel, per action. Anything unlisted gets a plain tap, so a
   new control is never silent by accident. */
const PRESS_FEEL = {
  'queue-next': 'success',
  'queue-recall': 'select',
  'join-queue': 'success',
  'rejoin': 'success',
  'leave-queue': 'warn',
  'toggle-live': 'select',
  'queue-pause': 'select',
  'apply-preset': 'select',
  'cycle-theme': 'select',
  'toggle-language': 'select',
  'sign-out': 'warn',
  'remove-ticket': 'warn'
};

/* Dispatch tables are read by own-property, never by plain indexing.
 *
 * `actions` and `PRESS_FEEL` are object literals keyed by a data-action
 * attribute, and an object literal answers for every name on Object.prototype:
 * actions['constructor'] is a function, so `actions[name]?.()` would have called
 * it, and PRESS_FEEL['toString'] is truthy, so `|| 'tap'` would have handed a
 * function to the vibration API.
 *
 * Nothing writes those attributes but this application, so this was never
 * reachable — but the same construct in an authorisation gate and a ticket
 * status both turned out to be defects, and a dispatcher keyed by a DOM
 * attribute is the last place worth leaving it. */
const handlerFor = name => (Object.hasOwn(actions, name) ? actions[name] : undefined);
const feelFor = name => (Object.hasOwn(PRESS_FEEL, name) ? PRESS_FEEL[name] : 'tap');

root.addEventListener('click', event => {
  const el = event.target.closest('[data-action]');
  if (!el || el.tagName === 'FORM') return;
  event.preventDefault();
  if (!el.disabled) buzz(feelFor(el.dataset.action));
  handlerFor(el.dataset.action)?.(event, el);
});

/* The press animation is driven from the pointer rather than :active so it
   completes even when the finger slides off, which is how a physical button
   behaves — you feel the click at the moment of contact. */
root.addEventListener('pointerdown', event => {
  const el = event.target.closest('button, .btn, .chip, .pill--switch, .icon-btn, a.btn');
  if (!el || el.disabled) return;
  el.classList.remove('pressed');
  void el.offsetWidth;
  el.classList.add('pressed');
  el.addEventListener('animationend', () => el.classList.remove('pressed'), { once: true });
}, { passive: true });

root.addEventListener('submit', event => {
  const form = event.target.closest('form[data-action]');
  if (!form) return;
  event.preventDefault();
  handlerFor(form.dataset.action)?.(event, form);
});

root.addEventListener('input', event => {
  const el = event.target;
  const id = el.id;

  if (['su-name', 'su-email', 'su-password', 'si-email', 'si-password', 'fp-email', 'np-password'].includes(id)) {
    const key = id.split('-')[1];
    ui.auth[key === 'name' ? 'name' : key === 'email' ? 'email' : 'password'] = el.value;
    if (id === 'su-password' || id === 'np-password') render();
    return;
  }
  if (el.dataset.search !== undefined) { ui.search = el.value; return render(); }
  if (id === 'add-name') { ui.add.name = el.value; return; }
  if (id === 'add-phone') { ui.add.phone = el.value; return; }
  if (id === 'join-name') { ui.join.name = el.value; return; }
  if (id === 'join-phone') { ui.join.phone = el.value; return; }

  if (el.dataset.setup) {
    ui.setup[el.dataset.setup] = el.value;
    if (el.dataset.setup === 'name') {
      ui.setup.slugPreview = el.value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      render();
    }
    if (el.type === 'range') {
      el.closest('.row-flex')?.querySelector('[data-range-label]')?.replaceChildren(`${el.value} min`);
    }
    return;
  }
  if (el.type === 'range') {
    /* Sliders do not all measure the same thing: the queue's is minutes, the
       display's is a percentage of its normal size. */
    const scale = el.dataset.qrRange === 'displayScale';
    const label = scale ? `${Math.round(Number(el.value) * 100)}%` : `${el.value} ${t('common.minShort')}`;
    el.closest('.setting__control, .row-flex')?.querySelector('[data-range-label]')?.replaceChildren(label);
    if (scale) scheduleSave(() => saveQr({ displayScale: Number(el.value) }));
    return;
  }
  if (el.dataset.business) {
    const patch = { [el.dataset.business]: el.value };
    return scheduleSave(async () => refreshBusiness((await api.updateBusiness(business().id, patch)).business));
  }
  if (el.dataset.brandHex) {
    if (!/^#[0-9a-fA-F]{6}$/.test(el.value)) return;
    return saveBrandColour(el.dataset.brandHex, el.value);
  }
  if (el.dataset.page) {
    const patch = { [el.dataset.page]: el.value };
    return scheduleSave(async () => refreshBusiness((await api.updateExperience(business().id, patch)).business));
  }
  if (el.dataset.qrText) {
    const patch = { [el.dataset.qrText]: el.value };
    return scheduleSave(async () => refreshBusiness((await api.updateQr(business().id, patch)).business));
  }
  if (el.dataset.queue) {
    const patch = { [el.dataset.queue]: el.value };
    return scheduleSave(async () => { await api.updateQueue(business().id, patch); await store.refreshQueue(); });
  }
  if (el.dataset.hours) {
    const patch = { queueSettings: { ...business().queueSettings, [el.dataset.hours]: el.value } };
    return scheduleSave(async () => refreshBusiness((await api.updateBusiness(business().id, patch)).business));
  }
  if (el.dataset.profile) {
    const patch = { [el.dataset.profile]: el.value };
    return scheduleSave(async () => {
      await api.updateProfile(patch);
      session.state.user = { ...session.state.user, ...patch };
    });
  }
});

root.addEventListener('change', async event => {
  const el = event.target;

  if (el.dataset.brand) {
    return saveBrandColour(el.dataset.brand, el.value);
  }
  if (el.dataset.qr) {
    return saveQr({ [el.dataset.qr]: el.value });
  }
  if (el.dataset.queueRange) {
    const patch = { [el.dataset.queueRange]: Number(el.value) };
    try { await api.updateQueue(business().id, patch); await store.refreshQueue(); } catch (error) { reportError(error); }
    return;
  }
  if (el.dataset.setup === 'avgServiceMin') {
    ui.setup.avgServiceMin = Number(el.value);
    return;
  }
  if (el.dataset.logo !== undefined && el.files?.[0]) {
    const picked = el.files[0];
    el.value = ''; // let the same file be picked again after a failure
    if (picked.size > MAX_INPUT_BYTES) {
      return toast(t('err.imageTooBig', { size: humanSize(picked.size) }), { variant: 'warn', timeout: 4200 });
    }
    ui.saving = true; render();
    try {
      // Decoded, resized and re-encoded here, so storage only ever holds a small
      // raster image and the owner never has to think about file size.
      const prepared = await prepareLogo(picked, { name: business().slug });
      const url = await session.uploadBrandingImage(prepared.file, { businessId: business().id });
      const { business: updated } = await api.updateBusiness(business().id, { logo: url });
      await refreshBusiness(updated);
      await api.updateBranding(business().id, { logo: url });
      toast(prepared.after < prepared.before
        ? `${t('brand.logoUpdated')} · ${humanSize(prepared.before)} → ${humanSize(prepared.after)}`
        : t('brand.logoUpdated'));
    } catch (error) {
      reportError(error, t('brand.uploadFailed'));
    } finally { ui.saving = false; render(); }
  }
});

/* Desk shortcuts. */
document.addEventListener('keydown', event => {
  /* While a dialog is open, Tab stays inside it. Anything else would let a
     keyboard user wander into the page behind the scrim. */
  if (event.key === 'Tab') {
    const trap = root.querySelector('[data-trap]');
    if (trap) {
      const focusable = [...trap.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(el => !el.disabled && el.offsetParent !== null);
      if (focusable.length) {
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
  }

  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

  if (event.key === 'Escape') {
    if (ui.dialog) return closeDialog(null);
    if (ui.addOpen || ui.accountOpen) { ui.addOpen = ui.accountOpen = false; return render(); }
  }
  if (typing || resolvedRoute.kind !== 'queue') return;

  const map = { n: 'queue-next', a: 'open-add', s: 'ticket-skip', p: 'queue-pause' };
  const key = event.key.toLowerCase();
  if (key === '/') {
    event.preventDefault();
    root.querySelector('[data-search]')?.focus();
    return;
  }
  if (Object.hasOwn(map, key)) {
    event.preventDefault();
    handlerFor(map[key])?.(event, root);
  }
});

/* ---------- lifecycle ---------- */

window.addEventListener('hashchange', () => {
  ui.addOpen = false;
  ui.accountOpen = false;
  navigate();
});
window.addEventListener('online', async () => {
  toast(t('msg.backOnline'), { timeout: 1800 });
  // A join made while offline completes itself rather than waiting for a tap.
  if (store.customer.pendingJoin) {
    await store.flushPending();
    if (!store.customer.pendingJoin) {
      history.replaceState(null, '', `#/t/${store.customer.slug}`);
      toast('You are in the queue');
      await navigate();
    }
  }
});
window.addEventListener('offline', () => toast(t('msg.offlineKeeping'), { variant: 'warn' }));

/* Waiting times are shown in whole minutes, so a slow tick keeps them honest.
   A hidden tab does not need to redraw at all, and a phone in a pocket should
   not be spending battery on it. */
setInterval(() => {
  if (document.hidden || ui.dialog) return;
  render();
}, 30_000);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  // Coming back to the tab: catch up immediately rather than at the next tick.
  if (store.customer.slug) store.refreshCustomer();
  else if (store.owner.business) store.refreshQueue();
  render();
});

/* Whatever happens — a failed boot, a slow account load, a network that never
   answers — something is on screen within a few seconds. The splash is a
   loading state, never a destination.

   This does not paint over an unresolved auth state; it ends it. abandonBoot()
   settles the phase to what is actually known, so the render that follows is
   made from a decided state rather than from a guess that beat the clock. */
/* Two limits, because "slow" and "never" deserve different answers.
 *
 * At the first, boot has overrun and we render whatever is known — unless a
 * session restore is still in flight, in which case the honest screen is still
 * the loading one: showing the landing page to somebody who turns out to be
 * signed in is worse than making them wait another moment.
 *
 * At the second there is no more waiting to do. Whatever is outstanding is
 * treated as failed and the interface renders, because a spinner that never
 * ends is the one outcome with no recovery at all. */
const RENDER_AT = 10_000;
const GIVE_UP_AT = 25_000;

const failsafe = setTimeout(() => {
  if (booted) return;
  if (session.isRestoring()) return;   // the ceiling below still applies
  console.warn('[diiwaan] boot overran; resolving without it');
  session.abandonBoot();
  booted = true;
  navigate();
}, RENDER_AT);

const ceiling = setTimeout(() => {
  if (booted) return;
  console.warn('[diiwaan] session restore never answered; rendering signed out');
  session.abandonBoot();
  booted = true;
  navigate();
}, GIVE_UP_AT);

try {
  await session.boot();
  if (session.isSignedIn()) {
    await Promise.race([
      store.loadAccount(),
      new Promise(resolve => setTimeout(resolve, 8000))
    ]);
  }
} catch (error) {
  console.error('Diiwaan could not start cleanly', error);
} finally {
  clearTimeout(failsafe);

  /* A restore still running is the one case where boot deliberately returns
     without an answer. Leave the boot screen up and let it finish; the phase
     change re-resolves the route on its own, and the ceiling above is what
     guarantees this ends. */
  if (session.isRestoring()) {
    session.onSessionChange(function once() {
      if (session.isInitializing()) return;
      clearTimeout(ceiling);
      if (!booted) { booted = true; navigate(); }
    });
  } else {
    clearTimeout(ceiling);
    // A boot that threw may have left the phase unset; nothing may render until
    // it is decided, so decide it here rather than leaving the splash up.
    session.abandonBoot();
    if (!booted) {
      booted = true;
      await navigate();
    }
  }
}
