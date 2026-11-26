// ===================================================
// MangaFlow Service Worker (PWA & Network-First Freshness)
// ===================================================

const CACHE_NAME = 'mangaflow-v2.0.0';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css?v=2.0.0',
  '/css/reader.css?v=2.0.0',
  '/js/state.js?v=2.0.0',
  '/js/api.js?v=2.0.0',
  '/js/reader.js?v=2.0.0',
  '/js/app.js?v=2.0.0',
  '/favicon.svg?v=2.0.0',
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

  // Bypass non-GET or cross-origin requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Bypass API and Image Proxy calls from SW cache
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') {
    return;
  }

  // Network-First with Cache Fallback so visitors ALWAYS see fresh UI/logo/CSS online
  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return networkResponse;
      })
      .catch(async () => {
        const cachedResponse = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
        if (cachedResponse) return cachedResponse;
        if (request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return undefined;
      })
  );
});
