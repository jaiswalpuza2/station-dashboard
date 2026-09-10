// Station — Service Worker
//
// Cache strategy:
//   Static shell (HTML, CSS, JS, icons, manifest) → cache-first.
//     These files only change on a new deploy; serving them from cache is
//     always correct and keeps the app instant to open.
//   API calls (Open-Meteo, Finnhub, Steam relay) → network-first with
//     stale-cache fallback.
//     Fresh data always matters, so we try the network first. If the network
//     fails (offline, relay down) we serve the most recently cached response
//     for that exact URL so the panel shows the last known reading rather than
//     a hard error. The app uses a separate offline-banner to signal staleness.
//
// The service worker only activates over HTTPS or on localhost/127.0.0.1.
// See the README for more detail.

const CACHE_STATIC  = 'station-static-v1';
const CACHE_API     = 'station-api-v1';

// All static assets to precache on install.
// Paths are relative to the service worker's own location (project root).
const STATIC_ASSETS = [
  '/',             // the root URL (what the PWA start_url resolves to on Vercel)
  'index.html',    // also cache by filename for direct requests
  'manifest.json',
  'css/styles.css',
  'js/app.js',
  'js/api.js',
  'js/markets-api.js',
  'js/games-api.js',
  'js/logbook.js',
  'js/gauges.js',
  'js/stripchart.js',
  'js/icons.js',
  'js/config.js',
  'js/config.example.js',
  'assets/icon-192.png',
  'assets/icon-512.png',
];

// URL prefixes that should use the network-first strategy.
// Anything matching these will fall back to the API cache on network failure.
const API_ORIGINS = [
  'https://api.open-meteo.com',
  'https://geocoding-api.open-meteo.com',
  'https://store.steampowered.com',
  'https://finnhub.io',
  'https://steam-relay.kavitachy702.workers.dev',
];

function isApiRequest(url) {
  return API_ORIGINS.some((origin) => url.startsWith(origin));
}

function isStaticRequest(url, requestUrl) {
  // Match requests to our own origin's static files
  return requestUrl.origin === self.location.origin;
}

// ---------------------------------------------------------------------------
// Install — precache static shell
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_STATIC).then((cache) => {
      // addAll() fetches and caches all assets; if any fetch fails the
      // install fails and the old SW stays active — safe-by-default.
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting()),
  );
});

// ---------------------------------------------------------------------------
// Activate — clean up old caches from previous versions
// ---------------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  const known = new Set([CACHE_STATIC, CACHE_API]);
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => !known.has(k)).map((k) => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  );
});

// ---------------------------------------------------------------------------
// Fetch — route requests to the right strategy
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests — POSTs and others are always passed through.
  if (request.method !== 'GET') return;

  const url = request.url;

  if (isApiRequest(url)) {
    // Network-first: try the network, fall back to cached response.
    // On network success, update the API cache with the fresh response.
    event.respondWith(networkFirstWithCache(request));
  } else {
    // Cache-first: serve from static cache; fall back to network for anything
    // not precached (e.g. Google Fonts, which the browser already caches).
    event.respondWith(cacheFirstWithNetwork(request));
  }
});

// ---------------------------------------------------------------------------
// Strategy implementations
// ---------------------------------------------------------------------------

async function networkFirstWithCache(request) {
  const cache = await caches.open(CACHE_API);
  try {
    const networkResponse = await fetch(request.clone());
    // Only cache successful responses — don't cache 4xx/5xx
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    // Network failed — serve the last cached response if one exists.
    const cached = await cache.match(request);
    if (cached) {
      // Clone the cached response and attach a custom header so the client
      // can detect that this is a stale fallback and show the offline banner.
      const headers = new Headers(cached.headers);
      headers.set('X-Station-Stale', '1');
      return new Response(cached.body, {
        status:     cached.status,
        statusText: cached.statusText,
        headers,
      });
    }
    // No cache either — re-throw so the app's existing error handling runs.
    throw err;
  }
}

async function cacheFirstWithNetwork(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  // Not in cache — fetch and opportunistically add to static cache.
  try {
    const networkResponse = await fetch(request.clone());
    if (networkResponse.ok) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    // For the static shell, there's nothing useful to return if both cache
    // and network fail — let the error propagate naturally.
    throw err;
  }
}
