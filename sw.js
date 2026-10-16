// Service worker: aplikacija radi bez interneta.
// Prvo pokušava mrežu (da odmah dobiješ novu verziju), a bez mreže koristi sačuvanu kopiju.
// Na slabom signalu ne čeka mrežu duže od NET_WAIT, nego otvara sačuvanu kopiju.
var CACHE = 'kartice';
var NET_WAIT = 3000;
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
  function fromCache() {
    return caches.match(req, { ignoreSearch: true }).then(function (hit) {
      return hit || (req.mode === 'navigate' ? caches.match('./index.html') : null);
    });
  }
  e.respondWith(new Promise(function (resolve) {
    var done = false;
    function finish(res) { if (!done && res) { done = true; resolve(res); } }
    // mreža kasni: sačuvana kopija odmah; ako je nema, i dalje se čeka mreža
    var timer = setTimeout(function () { fromCache().then(finish); }, NET_WAIT);
    fetch(req, { cache: 'no-cache' }).then(function (res) {
      clearTimeout(timer);
      if (res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      finish(res);
    }).catch(function () {
      clearTimeout(timer);
      fromCache().then(function (hit) { finish(hit || Response.error()); });
    });
  }));
});
