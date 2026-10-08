/* Art service worker — generated at build time from src/pwa/sw-template.js.
 * Precaches the whole app so it starts and works fully offline. A new
 * deployment changes VERSION, which installs a fresh cache and removes the
 * old one. Nothing the user creates is ever sent anywhere: this worker only
 * serves the app's own static files. */
const VERSION = 'd8dcc221b815';
const CACHE = `art-${VERSION}`;
const PRECACHE = [
  "./",
  "assets/index-BfGGwVjh.css",
  "assets/index-DIGGl536.js",
  "icons/apple-touch-icon.png",
  "icons/favicon-32.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/icon.svg",
  "index.html",
  "manifest.webmanifest"
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('art-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // App shell: always answer navigations from the cache (offline-first).
    const scope = self.registration.scope;
    event.respondWith(
      caches
        .match(new URL('index.html', scope).href)
        .then((cached) => cached || caches.match(scope))
        .then((cached) => cached || fetch(req)),
    );
    return;
  }
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (cached) =>
        cached ||
        fetch(req).then((res) => {
          // Cache other same-origin files (e.g. added later) for offline use.
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
