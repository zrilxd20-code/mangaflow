// ===================================================
// MangaFlow Service Worker (PWA & Offline Resilience)
// ===================================================

const CACHE_NAME = 'mangaflow-v1.0.3';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/css/reader.css',
  '/js/state.js',
  '/js/api.js',
  '/js/reader.js',
  '/js/app.js',
  '/favicon.svg',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[SW Install] Some assets could not be precached:', err.message);
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Bypass non-GET requests
  if (request.method !== 'GET') return;

  // Bypass API and Image Proxy calls from static cache (always network-first)
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Stale-While-Revalidate for app assets (CSS, JS, SVG, HTML) with SPA query support
  event.respondWith(
    caches.match(request, { ignoreSearch: request.mode === 'navigate' }).then((cachedResponse) => {
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return networkResponse;
        })
        .catch(async () => {
          if (cachedResponse) return cachedResponse;
          if (request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return undefined;
        });

      return cachedResponse || fetchPromise;
    })
  );
});
