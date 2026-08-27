/* Keeps the shell available when the network is slow, not merely when it is
   absent.

   The distinction matters. A plain network-first worker awaits fetch() with no
   deadline, so a stalled edge leaves the page blank indefinitely while a perfect
   copy sits in the cache unused. Every strategy here is bounded.

   ---------------------------------------------------------------------------
   Why the app's own code is NOT cache-first
   ---------------------------------------------------------------------------
   It used to be, and that was a real bug rather than a tuning choice.

   This frontend is a graph of ES modules at unversioned URLs — /js/app.js
   imports /js/session.js imports /js/views/auth.js — and they are only correct
   as a set. Serving them cache-first meant that after a deploy the browser got
   a fresh index.html from the network and then ran the PREVIOUS deploy's
   modules from the cache, refreshing them quietly in the background so the next
   load would be right. Two consequences, both of which were reported as
   symptoms rather than as caching:

     · a fix appeared not to have been applied, because the old code was still
       the code that ran;
     · worse, a half-updated set could run together — new app.js against old
       session.js — which is how a route decision gets made against auth logic
       that no longer matches it, and how a dashboard appears for a moment
       before the app corrects itself.

   So anything this project authors — its modules and its stylesheet — is now
   network-first with a bounded wait, exactly like the document that loads them.
   Online, you always get one coherent set. Offline, you get the last coherent
   set, because those responses are still cached; they are simply not preferred
   while the network can answer.

   Only genuinely immutable things stay cache-first: icons, the manifest, fonts,
   and branding images, which are addressed by an id that changes when the bytes
   change.

     the app's code           network first, bounded — one coherent set
     immutable assets         cache first, revalidated behind the paint
     the page itself          network first with a short deadline, so a deploy
                              is picked up but a slow edge cannot hold the
                              screen blank
     the API                  never cached; queue state is the server's word */

const CACHE = 'diiwaan-v9';
const NETWORK_DEADLINE_MS = 2500;

/* Code this project authors and ships as a set. Kept as a predicate rather than
   a list so a new view or helper is covered the day it is added — forgetting to
   add one here is exactly the kind of omission that puts a stale module back
   into a fresh page. */
const isOwnCode = url =>
  url.pathname.endsWith('.js') || url.pathname.endsWith('.css');

/* What the first paint actually needs, kept in step with the entry screens.
   The console and its views are fetched on demand and cached as they arrive. */
const SHELL = [
  '/',
  '/index.html',
  '/css/diiwaan.css',
  '/js/boot-paint.js',
  '/js/app.js',
  '/js/api.js',
  '/js/state.js',
  '/js/session.js',
  '/js/firebase-auth.js',
  '/js/realtime.js',
  '/js/theme.js',
  '/js/ui.js',
  '/js/i18n.js',
  '/js/palette.js',
  '/js/tokens.js',
  '/js/haptics.js',
  '/js/notify.js',
  '/js/image.js',
  '/js/views/auth.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png'
];

/** Resolves to null rather than waiting forever. */
function withDeadline(promise, ms) {
  return Promise.race([
    promise.catch(() => null),
    new Promise(resolve => setTimeout(() => resolve(null), ms))
  ]);
}

const save = (request, response) => {
  const copy = response.clone();
  caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
  return response;
};

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;

  // Queue state must come from the server, always.
  if (url.pathname.startsWith('/api/')) return;

  const isDocument = request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');

  if (isDocument || isOwnCode(url)) {
    /* Tried fresh first so a deploy lands, but only for as long as a person
       will wait. Past that the cached copy is served — it boots the app, which
       then talks to the API on its own terms. A document with nothing cached
       falls back to the shell; a module has no such substitute, so it falls
       through to the network and reports honestly if that fails. */
    event.respondWith((async () => {
      const fresh = await withDeadline(fetch(request), NETWORK_DEADLINE_MS);
      if (fresh && fresh.ok) return save(request, fresh);
      const cached = await caches.match(request);
      if (cached) return cached;
      return isDocument ? (await caches.match('/index.html')) || fetch(request) : fetch(request);
    })());
    return;
  }

  /* What is left is immutable: icons, the manifest, branding images addressed
     by an id that changes when the bytes do. Answered from cache immediately
     and refreshed behind the paint, so a repeat visit renders at local speed no
     matter what the edge is doing. A miss falls through to the network. */
  event.respondWith((async () => {
    const hit = await caches.match(request);
    if (hit) {
      event.waitUntil(fetch(request).then(r => (r.ok ? save(request, r) : r)).catch(() => {}));
      return hit;
    }
    const fresh = await withDeadline(fetch(request), NETWORK_DEADLINE_MS * 2);
    if (fresh && fresh.ok) return save(request, fresh);
    return fresh || fetch(request);
  })());
});

/* ---------- customer notifications ----------

   A push arrives even when Diiwaan is closed, which is the only reliable way the
   web can tell somebody their number is up while their phone is in a pocket. */

self.addEventListener('push', event => {
  if (!event.data) return;
  let payload = {};
  try { payload = event.data.json(); } catch { payload = { title: 'Diiwaan', body: event.data.text() }; }

  event.waitUntil(self.registration.showNotification(payload.title || 'Diiwaan', {
    body: payload.body || 'It is your turn.',
    icon: payload.icon || '/icon-192.png',
    badge: '/icon-192.png',
    tag: `diiwaan-${payload.slug || 'queue'}`,
    renotify: true,
    requireInteraction: payload.kind === 'called',
    vibrate: payload.kind === 'called' ? [200, 100, 200, 100, 200] : [140],
    data: { url: payload.url || '/' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Focus the queue if it is already open rather than stacking another tab.
      const open = clients.find(client => client.url.includes(url));
      if (open) return open.focus();
      return self.clients.openWindow(url);
    })
  );
});
