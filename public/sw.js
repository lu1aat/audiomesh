// Service worker with two jobs. Notifications on mobile browsers (Android Chrome refuses
// `new Notification()`; it needs registration.showNotification) and tapping one brings the
// chat back. And offline use and installation: every built file is cached at install, so the
// app opens and runs with no connection at all. Only same-origin GETs are ever answered.
//
// Pages are network-first: online, every load gets what is deployed, exactly as without a
// service worker, and refreshes the copy; offline, the copy is served. Everything else is
// cache-first, since the build names those files by their content. The previous build's cache
// is kept: a tab still running it loads its worklets and decoder worker again on every Audio on
// (and the stats chunk on demand), and a new deployment no longer has them.
//
// The build (vite.config.ts, `precache`) fills in the list and the version. In dev the list is
// empty and nothing is cached.
const PRECACHE = [];
const CACHE = 'audiomesh-precache-__VERSION__';
const PREFIX = 'audiomesh-precache-';
const scope = (path) => new URL(path, self.registration.scope).href;
// One entry per file, whatever query string a request carried.
const keyOf = (url) => {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.href;
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      if (PRECACHE.length) {
        const cache = await caches.open(CACHE);
        // 'reload': past the HTTP cache, which may still hold the previous build's pages.
        await cache.addAll(PRECACHE.map((path) => new Request(scope(path), { cache: 'reload' }))).catch(async (err) => {
          await caches.delete(CACHE); // never keep half a build; the next load tries again
          throw err;
        });
      }
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Only our own (other project pages on a github.io origin share Cache Storage), and not the
      // newest of the older ones. keys() lists caches in the order they were created.
      const older = (await caches.keys()).filter((k) => k.startsWith(PREFIX) && k !== CACHE);
      await Promise.all(older.slice(0, -1).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (PRECACHE.length === 0 || req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(req.mode === 'navigate' ? page(event) : file(event));
});

/** This build's copy, else the previous build's. */
async function cached(url) {
  const opts = { ignoreSearch: true };
  return (await (await caches.open(CACHE)).match(url, opts)) ?? (await caches.match(url, opts));
}

async function page(event) {
  try {
    const res = await fetch(event.request);
    if (res.ok) {
      const copy = res.clone();
      event.waitUntil(caches.open(CACHE).then((cache) => cache.put(keyOf(event.request.url), copy)));
    }
    return res;
  } catch {
    // Offline: the copy; any other page in scope gets the app.
    return (await cached(event.request.url)) ?? (await cached(scope('index.html'))) ?? Response.error();
  }
}

async function file(event) {
  const hit = await cached(event.request.url);
  if (hit) return hit;
  const res = await fetch(event.request);
  if (res.ok) {
    const copy = res.clone();
    event.waitUntil(caches.open(CACHE).then((cache) => cache.put(keyOf(event.request.url), copy)));
  }
  return res;
}

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
