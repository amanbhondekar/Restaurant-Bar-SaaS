const CACHE_NAME = 'mejwani-waiter-v3';
const ASSETS_TO_CACHE = [
  '/waiter.html',
  '/manifest.json',
  '/icons/waiter-icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Dynamic Hub API paths that must never be cached by service worker
const HUB_API_PATHS = [
  '/tables',
  '/orders',
  '/menu',
  '/pairing-info',
  '/auth',
  '/pair',
  '/qr',
  '/live',
  '/sync-status',
  '/dashboard-data'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('⚡ Waiter PWA Service Worker caching app shell');
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn('Pre-caching partial failure:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('🧹 Purging obsolete service worker cache:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 0. Completely bypass Service Worker in Vite dev mode or for source modules
  if (
    url.port === '3000' ||
    url.pathname.startsWith('/@') ||
    url.pathname.startsWith('/src/') ||
    url.pathname.startsWith('/node_modules/')
  ) {
    return;
  }

  // 1. Bypass Service Worker entirely for WebSocket & Hub API calls
  if (
    url.port === '4000' ||
    url.protocol === 'ws:' ||
    url.protocol === 'wss:' ||
    HUB_API_PATHS.some(path => url.pathname.startsWith(path))
  ) {
    return;
  }

  // 2. Navigation requests: serve cached waiter.html if network fails
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          return caches.match('/waiter.html').then((cached) => cached || caches.match(event.request));
        })
    );
    return;
  }

  // 3. Static assets: Stale-While-Revalidate
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
