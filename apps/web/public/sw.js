/**
 * Minimal Mesh service worker.
 *
 * Strategy:
 *   - Pre-cache the app shell at install
 *   - Stale-while-revalidate for same-origin GET requests
 *   - Bypass API + Supabase + auth + streaming endpoints entirely
 *   - Show an offline fallback HTML on navigation failures
 *
 * Versioning: bump CACHE_VERSION to invalidate.
 */

const CACHE_VERSION = 'mesh-v1';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

function isApiRequest(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.pathname.includes('/functions/v1/') ||
    url.hostname.endsWith('.supabase.co') ||
    url.hostname.endsWith('.supabase.io')
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept API / auth / streaming
  if (isApiRequest(url)) return;
  if (req.headers.get('accept')?.includes('text/event-stream')) return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(req);

      const networkPromise = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(() => null);

      if (cached) {
        // stale-while-revalidate
        networkPromise.catch(() => {});
        return cached;
      }

      const fresh = await networkPromise;
      if (fresh) return fresh;

      // Fallback offline page (use cached root)
      const offline = await cache.match('/');
      return (
        offline ??
        new Response('<h1>Offline</h1>', {
          status: 503,
          headers: { 'Content-Type': 'text/html' },
        })
      );
    })(),
  );
});
