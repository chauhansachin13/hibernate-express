/* Hibernate Express service worker: offline app shell, map tile cache and alarm notification actions. */
const VERSION = '__HX_VERSION__';
const PRECACHE = /*__HX_PRECACHE__*/[];
const SHELL = `hx-shell-${VERSION}`;
const TILES = 'hx-tiles-v1';
const TILE_LIMIT = 400;
const TILE_HOST = /^tile\.openstreetmap\.org$/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('hx-shell-') && k !== SHELL).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Pages: always try the network first so updates arrive, fall back offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match('./index.html', { ignoreVary: true })) || Response.error()),
    );
    return;
  }

  // Our own fingerprinted files: cache first.
  if (url.origin === self.location.origin) {
    event.respondWith(
      // ignoreVary: dev/preview servers send 'Vary: Origin', and module scripts are
      // requested with an Origin header the precache requests didn't have.
      caches.match(request, { ignoreVary: true }).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok && url.pathname.startsWith('/assets/')) {
              const copy = res.clone();
              caches.open(SHELL).then((cache) => cache.put(request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Map tiles: keep the ones you've seen, so the map still draws in dead zones.
  if (TILE_HOST.test(url.hostname)) event.respondWith(tile(request));
  // Routing and search always go to the network.
});

async function tile(request) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(request);
  const network = fetch(request)
    .then(async (res) => {
      if (res.ok) {
        await cache.put(request, res.clone());
        void trim(cache);
      }
      return res;
    })
    .catch(() => hit || Response.error());
  return hit || network;
}

async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length > TILE_LIMIT) {
    await Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map((key) => cache.delete(key)));
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (event.action === 'stop') windows.forEach((client) => client.postMessage({ type: 'hx-stop-alarm' }));
      const client = windows.find((c) => 'focus' in c);
      if (client) return client.focus();
      return self.clients.openWindow('./');
    })(),
  );
});
