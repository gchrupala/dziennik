// Service worker: aplikacja działa offline. Pliki aplikacji: najpierw sieć (z pominięciem cache HTTP),
// a gdy jej brak lub odpowiada zbyt wolno — kopia z cache.
const VERSION = '202611011037'; // podbijaj skryptem tools/bump-version.sh
const CACHE = `dziennik-${VERSION}`;
const CDN_CACHE = 'dziennik-cdn-v1'; // biblioteka Whisper (transformers.js, ONNX Runtime) z jsDelivr
const SHELL = [
  './',
  './index.html',
  `./css/style.css?v=${VERSION}`,
  `./js/app.js?v=${VERSION}`,
  `./js/db.js?v=${VERSION}`,
  `./js/recorder.js?v=${VERSION}`,
  `./js/context.js?v=${VERSION}`,
  `./js/whisper.js?v=${VERSION}`,
  `./js/sync.js?v=${VERSION}`,
  `./js/whisper-worker.js?v=${VERSION}`,
  `./js/pcm-worklet.js?v=${VERSION}`,
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'no-cache' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('dziennik-') && k !== CACHE && k !== CDN_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Izolacja cross-origin (COOP/COEP) pozwala Whisperowi liczyć na wielu wątkach (SharedArrayBuffer).
function isolate(res) {
  if (!res || res.type === 'opaque' || res.status === 0) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Pliki z CDN mają wersję w adresie — cache-first, żeby działały offline.
  if (url.origin === 'https://cdn.jsdelivr.net') {
    e.respondWith((async () => {
      const cache = await caches.open(CDN_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  if (url.origin !== self.location.origin) return; // API pogody, modele itp. — bez udziału SW

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const network = fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);
    const timeout = new Promise((r) => setTimeout(() => r(null), 4000));
    let res = await Promise.race([network, timeout]);
    if (!res) {
      res = (await cache.match(req, { ignoreSearch: true }))
        || (req.mode === 'navigate' && (await cache.match('./index.html')))
        || (await network);
    }
    return res ? isolate(res) : Response.error();
  })());
});
