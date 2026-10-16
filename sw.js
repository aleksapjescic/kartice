// Service worker: aplikacija radi bez interneta.
// Uvek prvo pokušava mrežu (da odmah dobiješ novu verziju), a bez mreže koristi sačuvanu kopiju.
var CACHE = 'kartice';
var FILES = [
  './', './index.html', './styles.css', './data.js', './i18n.js', './app.js',
  './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png',
  './vendor/pdf.min.js', './vendor/pdf.worker.min.js', './vendor/mammoth.browser.min.js', './vendor/page-flip.browser.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req, { cache: 'no-cache' }).then(function (res) {
      if (res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        return hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error());
      });
    })
  );
});
