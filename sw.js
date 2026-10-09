const CACHE_NAME = 'carlyrics-v9';
const ASSETS = [
  './',
  './index.html',
  './style.css?v=9',
  './app.js?v=9',
  './vendor/sanscript.min.js?v=9',
  './vendor/any-ascii.mjs?v=9',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Only the app's own files: Spotify, LRCLIB, fonts and album art go straight to the network
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Our API answers are cached by the app itself (and at Vercel's edge)
  if (url.pathname.startsWith('/api/')) return;

  // Stale-while-revalidate: open instantly from cache (weak signal in the car),
  // refresh the cached copy in the background for next time
  e.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const isPage = e.request.mode === 'navigate';
      // The OAuth redirect lands on /?code=..., which is still the app page
      const cached = await cache.match(isPage ? './' : e.request, { ignoreSearch: isPage });

      const network = fetch(e.request)
        .then((res) => {
          if (res.ok) cache.put(isPage ? './' : e.request, res.clone());
          return res;
        })
        .catch(() => cached);

      if (cached) {
        e.waitUntil(network);
        return cached;
      }
      return network;
    })
  );
});
