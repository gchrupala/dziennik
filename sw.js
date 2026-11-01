// Service worker: aplikacja działa offline. Strategia stale-while-revalidate dla plików aplikacji.
const CACHE = 'dziennik-v1';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/recorder.js',
  './js/context.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return; // API pogody itp. bez cache
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req)
      .then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);
    if (cached) {
      e.waitUntil(network);
      return cached;
    }
    return (await network) || (req.mode === 'navigate' && (await cache.match('./index.html'))) || Response.error();
  })());
});
