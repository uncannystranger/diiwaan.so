/* Keeps the shell available when the network is not.

   Network first, so a deploy is picked up immediately and the cache is only a
   fallback — a queue app that serves yesterday's JavaScript would be worse than
   one that fails honestly. The API is never cached here; freshness of queue
   state is the server's business. Bump CACHE to retire an old shell. */

const CACHE = 'diiwaan-v3';
const SHELL = [
  '/',
  '/index.html',
  '/css/diiwaan.css',
  '/js/app.js',
  '/js/api.js',
  '/js/state.js',
  '/js/session.js',
  '/js/realtime.js',
  '/js/theme.js',
  '/js/ui.js',
  '/js/qr.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png'
];

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
  // The API is never served from cache: queue state must come from the server.
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then(hit => hit || caches.match('/index.html')))
  );
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
