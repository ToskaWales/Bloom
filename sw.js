const CACHE = 'bloom-v2';
const ASSETS = [
  '.',
  'index.html',
  'styles.css',
  'app.js',
  'icon.svg',
  'manifest.json',
];

// Install — pre-cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate — delete old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch — cache-first for same-origin assets, network-only for external
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Let Firebase, Google Fonts, and other external requests go straight to network
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      // Kick off a background network fetch to keep cache fresh
      const networkFetch = fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {});

      // Return cached version immediately if available, otherwise wait for network
      return cached || networkFetch;
    })
  );
});
