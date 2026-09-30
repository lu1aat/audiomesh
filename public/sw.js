// Service worker with two jobs. Notifications on mobile browsers (Android Chrome refuses
// `new Notification()`; it needs registration.showNotification) and tapping one brings the
// chat back. And offline: the built files are cached once and served from the cache, so the
// app opens with no connection at all. Only same-origin GETs are ever answered, from the cache
// or, for anything not in it, from the network as if this worker did not exist.
//
// The build (vite.config.ts, `precache`) fills in the list and the version. In dev the list is
// empty and nothing is cached.
const PRECACHE = [];
const CACHE = 'audiomesh-precache-__VERSION__';
const PREFIX = 'audiomesh-precache-';
const scope = (path) => new URL(path, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (PRECACHE.length ? caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map(scope))) : Promise.resolve()).then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (PRECACHE.length === 0 || req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (hit) => hit || (req.mode === 'navigate' ? caches.match(scope('index.html')) : undefined) || fetch(req),
    ),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list[0];
      if (open) return open.focus();
      return self.clients.openWindow(self.registration.scope);
    }),
  );
});
