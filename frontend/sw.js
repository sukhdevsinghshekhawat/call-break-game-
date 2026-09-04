// Call Break — offline app-shell cache.
// Caches the static assets so the game can be loaded without a network
// after the very first visit (needed for the offline 4-Phone mode).
const CACHE = 'callbreak-shell-v1';
const ASSETS = [
  '/',
  '/game.html',
  '/net.js',
  '/roomcore.js',
  '/p2p.js',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(ASSETS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        // Cache same-origin successful responses for next time.
        if (res && res.ok && new URL(req.url).origin === location.origin) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () {
        // Offline navigation fallback to the cached app shell.
        if (req.mode === 'navigate') return caches.match('/game.html');
      });
    })
  );
});
