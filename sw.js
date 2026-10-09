const CACHE_NAME = 'carlyrics-v6';
const ASSETS = [
  './',
  './index.html',
  './style.css?v=6',
  './app.js?v=6',
  './vendor/sanscript.min.js?v=6',
  './vendor/any-ascii.mjs?v=6',
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
  // Let external API calls pass through normally to network
  if (e.request.url.includes('spotify.com') || e.request.url.includes('lrclib.net')) {
    return;
  }
  // Network-first so code updates apply immediately
  e.respondWith(
    fetch(e.request)
      .then((networkRes) => {
        if (networkRes.status === 200) {
          const resClone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, resClone));
        }
        return networkRes;
      })
      .catch(() => caches.match(e.request))
  );
});
