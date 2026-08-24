/* Keeps the shell available when the network is slow, not merely when it is
   absent.

   The distinction matters. A plain network-first worker awaits fetch() with no
   deadline, so a stalled edge leaves the page blank indefinitely while a perfect
   copy sits in the cache unused. Every strategy here is bounded:

     assets (JS, CSS, icons)  cache first, revalidated in the background — a
                              repeat visit paints without touching the network
     the page itself          network first with a short deadline, so a deploy
                              is picked up but a slow edge cannot hold the
                              screen blank
     the API                  never cached; queue state is the server's word

   Bump CACHE to retire an old shell. */

const CACHE = 'diiwaan-v4';
const NETWORK_DEADLINE_MS = 2500;

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
  '/js/realtime.js',
  '/js/theme.js',
  '/js/ui.js',
  '/js/i18n.js',
  '/js/palette.js',
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

  if (isDocument) {
    /* The page is tried fresh first so a deploy lands, but only for as long as
       a person will wait. Past that, the cached shell is shown — it boots the
       app, which then talks to the API on its own terms. */
    event.respondWith((async () => {
      const fresh = await withDeadline(fetch(request), NETWORK_DEADLINE_MS);
      if (fresh && fresh.ok) return save(request, fresh);
      return (await caches.match(request))
        || (await caches.match('/index.html'))
        || fetch(request);
    })());
    return;
  }

  /* Assets are answered from cache immediately and refreshed behind the paint,
     so the second visit renders at local speed no matter what the edge is
     doing. A miss falls through to the network with the same deadline. */
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
