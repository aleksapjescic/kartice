// Service worker: aplikacija radi bez interneta.
// Prvo pokušava mrežu (da odmah dobiješ novu verziju), a bez mreže koristi sačuvanu kopiju.
// Na slabom signalu ne čeka mrežu duže od NET_WAIT, nego otvara sačuvanu kopiju.
var CACHE = 'kartice';
var NET_WAIT = 3000;
// fontovi za formule (KaTeX), da formule rade i bez interneta
var KATEX_FONTS = [
  'KaTeX_AMS-Regular.woff2',
  'KaTeX_Caligraphic-Bold.woff2',
  'KaTeX_Caligraphic-Regular.woff2',
  'KaTeX_Fraktur-Bold.woff2',
  'KaTeX_Fraktur-Regular.woff2',
  'KaTeX_Main-Bold.woff2',
  'KaTeX_Main-BoldItalic.woff2',
  'KaTeX_Main-Italic.woff2',
  'KaTeX_Main-Regular.woff2',
  'KaTeX_Math-BoldItalic.woff2',
  'KaTeX_Math-Italic.woff2',
  'KaTeX_SansSerif-Bold.woff2',
  'KaTeX_SansSerif-Italic.woff2',
  'KaTeX_SansSerif-Regular.woff2',
  'KaTeX_Script-Regular.woff2',
  'KaTeX_Size1-Regular.woff2',
  'KaTeX_Size2-Regular.woff2',
  'KaTeX_Size3-Regular.woff2',
  'KaTeX_Size4-Regular.woff2',
  'KaTeX_Typewriter-Regular.woff2'
];
var FILES = [
  './', './index.html', './styles.css', './data.js', './i18n.js', './store.js', './srs.js', './markup.js', './stats.js', './ai.js', './config.js', './sync.js', './admin.js', './app.js', './privacy.html',
  './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png',
  './vendor/pdf.min.js', './vendor/pdf.worker.min.js', './vendor/mammoth.browser.min.js', './vendor/page-flip.browser.js',
  './vendor/ts-fsrs.umd.js', './vendor/katex/katex.min.js', './vendor/katex/katex.min.css', './vendor/supabase.min.js'
].concat(KATEX_FONTS.map(function (f) { return './vendor/katex/fonts/' + f; }));

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

// podsetnik za učenje (Web Push, šalje ga supabase/functions/reminders)
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Kartice', {
    body: d.body || 'Vreme je za učenje.', icon: 'icon-192.png', badge: 'icon-192.png', tag: 'kartice-podsetnik', data: { url: d.url || './' }
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if ('focus' in list[i]) return list[i].focus();
    return self.clients.openWindow(url);
  }));
});
