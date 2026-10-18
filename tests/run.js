/* Kartice — testovi bez pregledača: node tests/run.js
   Učitavaju se pravi fajlovi aplikacije (srs.js, stats.js, markup.js, sync.js, store.js, sw.js, i18n.js)
   u izolovan kontekst. Iz app.js se vade samo male pomoćne funkcije, jer app.js odmah crta stranicu. */
var fs = require('fs'), path = require('path'), vm = require('vm');
var ROOT = path.join(__dirname, '..');
function src(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }

// funkcija iz app.js po imenu (do zatvorene vitičaste zagrade na istom nivou)
function fnFrom(code, name) {
  var i = code.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('nema funkcije ' + name);
  var j = code.indexOf('{', i), depth = 0;
  for (var k = j; k < code.length; k++) {
    if (code[k] === '{') depth++;
    else if (code[k] === '}' && --depth === 0) return code.slice(i, k + 1);
  }
  throw new Error('nezatvorena funkcija ' + name);
}

function makeContext() {
  var store = {};
  var ctx = {
    console: console, Math: Math, Date: Date, JSON: JSON, Object: Object, Array: Array, String: String, Number: Number,
    RegExp: RegExp, Error: Error, Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout, Intl: Intl,
    localStorage: { getItem: function (k) { return store[k] || null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } },
    navigator: { onLine: true }, window: {}, location: { origin: 'http://x' },
    document: { addEventListener: function () {}, getElementById: function () { return null; }, querySelector: function () { return null; } }
  };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(src('i18n.js') + src('data.js') + src('vendor/ts-fsrs.umd.js'), ctx);
  var app = src('app.js');
  var helpers = ['uid', 'shuffled', 'esc', 'defaultDeck', 'normalize', 'cardById', 'optionList', 'questionIssue', 'playable', 'noteFileIds', 'cardImages', 'deckFileIds', 'allFileIds', 'nextNo', 'fold'];
  vm.runInContext(helpers.map(function (n) { return fnFrom(app, n); }).join('\n') +
    '\nvar LETTERS = "ABCDEFGHIJ";\nfunction toast() {}\nfunction loadScript() { return Promise.resolve(); }\n', ctx);
  vm.runInContext(src('store.js') + src('srs.js') + src('markup.js') + src('stats.js') + src('sync.js'), ctx);
  // IndexedDB ne postoji u Node-u: kopije i istorija se samo pamte u memoriji
  vm.runInContext('var __backups = {}, __log = []; backupPut = function (id, r) { __backups[id] = r; return Promise.resolve(); };' +
    'logAdd = function (e) { __log.push(e); return Promise.resolve(); }; logDel = function (id) { __log = __log.filter(function (e) { return e.id !== id; }); return Promise.resolve(); };' +
    'idb = function () { return Promise.resolve(undefined); }; saveNow = function () { return Promise.resolve(); }; syncSaveMeta = function () { return Promise.resolve(); };' +
    'function render() {} var ui = { screen: "home" }; function modal() {}', ctx);
  return ctx;
}

var passed = 0, failed = 0, current = '';
function check(cond, msg) {
  if (cond) passed++;
  else { failed++; console.log('  ✗ ' + current + ': ' + msg); }
}
async function test(name, fn) {
  current = name;
  try { await fn(); } catch (e) { failed++; console.log('  ✗ ' + name + ': ' + (e && e.stack || e)); }
}

(async function () {
  /* ---------- raspored ponavljanja ---------- */
  await test('FSRS: nova kartica i ocene', function () {
    var c = makeContext();
    vm.runInContext('data = normalize({ decks: [defaultDeck()], schema: 2 });', c);
    var now = Date.UTC(2026, 9, 18, 10);
    var pv = c.srsPreview('c:mreze:c0', now);
    check(pv[1] === '1 min' && pv[3] === '10 min', 'intervali za novu: ' + JSON.stringify(pv));
    c.srsRate('c:mreze:c0', 3, now);
    var rv = c.data.rev['c:mreze:c0'];
    check(rv.st === 1 && rv.due === now + 10 * 60000, 'posle Dobro: učenje, 10 min');
    c.srsRate('c:mreze:c0', 3, now + 11 * 60000);
    rv = c.data.rev['c:mreze:c0'];
    check(rv.st === 2 && rv.due - now >= 864e5, 'drugo Dobro: ponavljanje, bar 1 dan (' + (rv.due - now) / 864e5 + ' d)');
    var prev = c.srsRate('c:mreze:c0', 1, now + 3 * 864e5);
    check(prev && prev.st === 2 && c.data.rev['c:mreze:c0'].l === 1, 'Ponovo na naučenoj: zaboravljanje se broji');
  });
  await test('Red za danas: granice i redosled', function () {
    var c = makeContext();
    vm.runInContext('data = normalize({ decks: [defaultDeck()], schema: 2 }); data.settings.newPerDay = 3;', c);
    var now = Date.now();
    c.data.rev['c:mreze:c5'] = { due: now - 1000, s: 5, d: 5, el: 0, sd: 5, r: 2, l: 0, ls: 0, st: 2, lr: now - 5 * 864e5 };
    c.data.rev['c:mreze:c6'] = { due: now - 5000, s: 1, d: 5, el: 0, sd: 0, r: 1, l: 0, ls: 1, st: 1, lr: now - 600000 };
    var q = c.buildQueue(c.allDeckKeys(), now);
    check(q[0] === 'c:mreze:c6', 'učenje prvo: ' + q[0]);
    check(q.filter(function (k) { return c.isFresh(k); }).length === 3, 'tačno 3 nove');
    check(q.length === 5, 'ukupno 5: ' + q.length);
    var cnt = c.todayCounts(c.allDeckKeys(), now);
    check(cnt.total === 5 && cnt.review === 1 && cnt.learn === 1 && cnt.fresh === 3, 'brojevi za danas ' + JSON.stringify(cnt));
  });
  await test('Praznine: stavke i prikaz', function () {
    var c = makeContext();
    vm.runInContext('data = normalize({ decks: [{ id: "d", name: "D", cards: [{ id: "k", type: "cloze", q: "A {{b}} c {{d::nag}}", a: "" }] }], schema: 2 });', c);
    check(c.deckKeys(c.data.decks[0]).join() === 'c:d:k:1,c:d:k:2', 'dve stavke');
    check(/cloze-gap">\[…\]/.test(c.renderMarkup(c.clozeText('A {{b}} c {{d::nag}}', 1, false))), 'prva praznina skrivena');
    check(/cloze-gap">\[nag\]/.test(c.renderMarkup(c.clozeText('A {{b}} c {{d::nag}}', 2, false))), 'nagoveštaj');
    check(/<mark class="cloze-ans">b<\/mark>/.test(c.renderMarkup(c.clozeText('A {{b}} c {{d::nag}}', 1, true))), 'otkriven odgovor');
  });

  /* ---------- migracija iz verzije 12 ---------- */
  await test('Migracija iz verzije 12', async function () {
    var c = makeContext();
    vm.runInContext('var old = { decks: [defaultDeck()], quizzes: [{ id: "z", name: "Z", known: { q1: true }, questions: [{ id: "q1", q: "Q?", options: ["a", "b"], correct: 0 }] }], notes: [], theme: "auto" };' +
      'old.decks[0].cards.slice(0, 10).forEach(function (k) { old.decks[0].known[k.id] = true; });', c);
    var changed = await c.migrateData(c.old);
    c.data = c.normalize(c.old);
    var rev = Object.keys(c.data.rev), now = Date.now();
    check(changed && c.data.schema === 2, 'šema 2');
    check(c.__backups['pre-v2'] && c.__backups['pre-v2'].schema === 1 && !c.__backups['pre-v2'].data.rev, 'kopija verzije 12 pre migracije');
    check(rev.length === 11, '10 kartica + 1 pitanje u rasporedu: ' + rev.length);
    check(rev.every(function (k) { var d = (c.data.rev[k].due - now) / 864e5; return c.data.rev[k].st === 2 && d > 0 && d <= 8; }), 'rokovi kroz sledećih 7 dana');
    check(c.data.decks[0].cards.length === 52 && Object.keys(c.data.decks[0].known).length === 10, 'kartice i oznake netaknute');
    check(await c.migrateData(c.data) === false, 'druga migracija ne radi ništa');
  });

  /* ---------- formatiranje i bezbednost ---------- */
  await test('Formatiranje', function () {
    var c = makeContext();
    var h = c.renderMarkup('# Naslov\n**b** *i* ==m== `k`\n- x\n- y\n\n1. a\n2. b\n$x^2$ https://example.com');
    ['<h2>Naslov</h2>', '<b>b</b>', '<i>i</i>', '<mark>m</mark>', '<code>k</code>', '<ul><li>x</li><li>y</li></ul>', '<ol><li>a</li><li>b</li></ol>', 'class="math" data-tex="x^2"', 'href="https://example.com"']
      .forEach(function (s) { check(h.indexOf(s) >= 0, 'nema ' + s); });
    check(c.plainText('**b** *i* ==m== $x$ [t](https://a.b)') === 'b i m x t', 'običan tekst: ' + c.plainText('**b** *i* ==m== $x$ [t](https://a.b)'));
  });
  await test('Formatiranje: XSS ostaje tekst', function () {
    var c = makeContext();
    var evil = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '[x](javascript:alert(1))', '"><svg onload=alert(1)>', '$x" onmouseover="a$', '`<b onclick=1>`', '[a](https://x" onclick="y)'];
    evil.forEach(function (e) {
      var h = c.renderMarkup(e);
      check(!/<(script|img|svg|iframe)/i.test(h), 'oznaka u ' + e + ' → ' + h);
      // atributi svake oznake (vrednosti su uvek u dvostrukim navodnicima, a " u njima je &quot;)
      var tags = h.match(/<[a-z][^>]*>/gi) || [], bad = tags.some(function (tag) {
        var names = [], re = /\s([a-z-]+)(?:="[^"]*")?/gi, m;
        while ((m = re.exec(tag.replace(/^<[a-z0-9]+/i, '')))) names.push(m[1].toLowerCase());
        return names.some(function (n) { return n.indexOf('on') === 0; });
      });
      check(!bad, 'atribut on* u ' + e + ' → ' + h);
      check(!/href="javascript:/i.test(h), 'javascript: link u ' + e);
    });
  });

  /* ---------- statistika ---------- */
  await test('Statistika: dani, zbir uređaja, niz dana', function () {
    var c = makeContext();
    vm.runInContext('data = normalize({ decks: [defaultDeck()], schema: 2 });', c);
    var today = c.dayKey();
    c.data.days = { a: {}, b: {} };
    c.data.days.a[today] = { a: 3, n: 1, rv: 2, ok: 2, ms: 1000 };
    c.data.days.b[today] = { a: 4, n: 0, rv: 4, ok: 3, ms: 2000 };
    var y = c.prevDayKey(today), y2 = c.prevDayKey(y), y4 = c.prevDayKey(c.prevDayKey(y2));
    c.data.days.a[y] = { a: 1 }; c.data.days.b[y2] = { a: 2 }; c.data.days.a[y4] = { a: 1 };
    var t = c.dayTotals(today);
    check(t.a === 7 && t.rv === 6 && t.ok === 5, 'zbir dva uređaja ' + JSON.stringify(t));
    var s = c.streak();
    check(s.cur === 3 && s.best === 3 && s.today, 'niz 3 dana: ' + JSON.stringify(s));
    check(c.prevDayKey('2026-03-01') === '2026-02-28' && c.prevDayKey('2026-01-01') === '2025-12-31', 'prethodni dan');
  });

  /* ---------- sinhronizacija ---------- */
  await test('Sinhronizacija: dva uređaja, lažni server', async function () {
    var c = makeContext();
    // server: pobeđuje novija izmena (kao sync_push u supabase/schema.sql)
    var table = new Map(), tick = 0;
    function ts() { return new Date(Date.UTC(2026, 0, 1) + (++tick) * 1000).toISOString(); }
    function query() {
      var st = { gt: null };
      var b = { select: function () { return b; }, order: function () { return b; }, range: function () { return b; }, gt: function (k, v) { st.gt = v; return b; },
        then: function (res) { var rows = Array.from(table.values()).sort(function (x, y) { return x.server_ts < y.server_ts ? -1 : 1; }); if (st.gt) rows = rows.filter(function (r) { return r.server_ts > st.gt; }); res({ data: JSON.parse(JSON.stringify(rows)), error: null }); } };
      return b;
    }
    c.syncClient = function () { return Promise.resolve({ from: query, storage: { from: function () { return { list: function () { return Promise.resolve({ data: [] }); }, remove: function () { return Promise.resolve({}); } }; } },
      rpc: function (n, a) { a.rows.forEach(function (r) { var k = r.kind + '|' + r.id, ex = table.get(k); if (ex && ex.updated > r.updated) return; table.set(k, Object.assign({}, JSON.parse(JSON.stringify(r)), { server_ts: ts() })); }); return Promise.resolve({ error: null }); } }); };
    var A = c.normalize({ decks: [c.defaultDeck()], notes: [{ id: 'n1', type: 'text', title: 'B', body: 'x', folderId: null }], schema: 2 });
    A.decks[0].known.c0 = true;
    A.rev['c:mreze:c0'] = { due: 1, s: 1, d: 1, st: 2 };
    var B = c.normalize({ decks: [c.defaultDeck()], schema: 2 });
    var dev = { A: { data: A, id: 'devA', meta: null }, B: { data: B, id: 'devB', meta: null } };
    async function on(n, fn) {
      var d = dev[n]; c.data = d.data; c.DEVICE_ID = d.id; c.sync.user = { id: 'u' };
      c.sync.meta = d.meta || { uid: 'u', shadow: {}, files: {}, lastPull: null, gc: Date.now() };
      if (fn) fn(c.data);
      await c.syncRun(); d.meta = c.sync.meta; d.data = c.data;
    }
    await on('A'); await on('B');
    check(dev.B.data.notes.length === 1 && dev.B.data.decks[0].known.c0 && dev.B.data.rev['c:mreze:c0'], 'novi uređaj dobija sve');
    await on('A', function (d) { d.decks[0].cards[1].q = 'A2'; });
    await on('B', function (d) { d.decks[0].cards[2].q = 'B3'; });
    await on('A');
    check(dev.A.data.decks[0].cards[1].q === 'A2' && dev.A.data.decks[0].cards[2].q === 'B3', 'obe izmene na A');
    check(dev.B.data.decks[0].cards[1].q === 'A2' && dev.B.data.decks[0].cards[2].q === 'B3', 'obe izmene na B');
    await on('A', function (d) { d.decks[0].cards[3].q = 'A prvi'; });
    await new Promise(function (r) { setTimeout(r, 5); });
    await on('B', function (d) { d.decks[0].cards[3].q = 'B kasnije'; });
    await on('A');
    check(dev.A.data.decks[0].cards[3].q === 'B kasnije' && dev.B.data.decks[0].cards[3].q === 'B kasnije', 'ista kartica: kasnija izmena');
    await on('A', function (d) { d.notes = []; d.decks[0].cards.push({ id: 'nova', n: '99', q: 'N', a: '' }); });
    await on('B');
    check(!dev.B.data.notes.length, 'brisanje stiže');
    check(dev.B.data.decks[0].cards.map(function (x) { return x.id; }).join() === dev.A.data.decks[0].cards.map(function (x) { return x.id; }).join(), 'isti redosled kartica');
    c.data = dev.B.data; c.sync.meta = dev.B.meta;
    check(c.syncDiff().length === 0, 'posle sinhronizacije nema ničeg za slanje');
  });

  /* ---------- AI: tvoj ključ ili ključ aplikacije ---------- */
  await test('AI: izvor ključa i poruke za ključ aplikacije', function () {
    var c = makeContext();
    vm.runInContext(src('ai.js') + '\ndata = normalize({ decks: [defaultDeck()], schema: 2 });', c);
    check(c.aiKeySource() === 'own', 'bez Supabase-a uvek svoj ključ');
    vm.runInContext('var SUPABASE_URL = "https://x.supabase.co", SUPABASE_ANON_KEY = "anon";', c);
    check(c.aiKeySource() === 'app', 'bez svog ključa: ključ aplikacije');
    check(c.aiProvider() === 'gemini', 'ključ aplikacije je uvek Gemini');
    check(!c.aiReady(), 'bez prijave nije spremno');
    c.sync.user = { id: 'u1' };
    check(c.aiReady(), 'prijavljen: spremno');
    c.localStorage.setItem('kartice.geminiKey', 'AIzaSyTESTTESTTESTTESTTESTTEST');
    check(c.aiKeySource() === 'own', 'sa svojim ključem: podrazumevano svoj');
    c.sync.user = null;
    c.aiSetSource('app');
    check(c.aiKeySource() === 'app', 'izabran ključ aplikacije se pamti');
    c.aiSetSource('own');
    check(c.aiKeySource() === 'own', 'izabran svoj ključ se pamti');
    check(!c.aiReady(), 'svoj ključ: Claude bez Claude ključa nije spreman');
    c.data.settings.aiProvider = 'gemini';
    check(c.aiReady(), 'svoj ključ: Gemini sa Gemini ključem je spreman');
    var e = c.aiErrorText;
    check(/\(20\)/.test(e({ app: true, reason: 'limit', limit: 20 })), 'limit sa brojem');
    check(/blokiran/.test(e({ app: true, reason: 'blocked' })), 'blokiran');
    check(/isključen/.test(e({ app: true, reason: 'disabled' })), 'isključen');
    check(/Prijavi se/.test(e({ app: true, reason: 'auth' })), 'nije prijavljen');
    check(/kvota/.test(e({ app: true, gemini: true, status: 429 })), 'zajednička kvota');
    check(/administratoru/.test(e({ app: true, gemini: true, status: 404 })), 'pogrešan model kod admina');
    check(/Gemini ključ nije ispravan/.test(e({ gemini: true, status: 401, message: '' })), 'svoj Gemini ključ: kao ranije');
  });

  /* ---------- service worker ---------- */
  await test('Service worker: mreža, keš, čekanje', async function () {
    var code = src('sw.js').replace('var NET_WAIT = 3000;', 'var NET_WAIT = 60;');
    var handlers = {}, cache = {}, net = null;
    var self = { addEventListener: function (t, f) { handlers[t] = f; }, skipWaiting: function () {}, clients: { claim: function () {} }, registration: {} };
    var caches = { match: function (r) { return Promise.resolve(cache[typeof r === 'string' ? r : r.url.split('?')[0]]); }, open: function () { return Promise.resolve({ put: function () {}, addAll: function () {} }); } };
    function Resp(b, ok) { this.body = b; this.ok = ok !== false; }
    Resp.prototype.clone = function () { return new Resp(this.body, this.ok); };
    Resp.error = function () { return new Resp('ERR', false); };
    new Function('self', 'caches', 'fetch', 'Response', 'location', code)(self, caches, function () { return net(); }, Resp, { origin: 'http://x' });
    function run(url, mode) { return new Promise(function (res) { handlers.fetch({ request: { method: 'GET', url: url, mode: mode }, respondWith: function (p) { p.then(function (r) { res(r.body); }); } }); }); }
    function wait(ms, v, fail) { return function () { return new Promise(function (ok, no) { setTimeout(function () { if (fail) no(new Error('x')); else ok(new Resp(v)); }, ms); }); }; }
    cache = {}; net = wait(5, 'mreza'); check(await run('http://x/a.js') === 'mreza', 'brza mreža');
    cache = { 'http://x/a.js': new Resp('kes') }; net = wait(200, 'mreza'); check(await run('http://x/a.js') === 'kes', 'spora mreža: keš');
    cache = {}; net = wait(150, 'mreza'); check(await run('http://x/a.js') === 'mreza', 'spora mreža bez keša: čeka');
    cache = { './index.html': new Resp('index') }; net = wait(5, null, true); check(await run('http://x/s', 'navigate') === 'index', 'bez mreže: stranica');
    check(typeof handlers.push === 'function' && typeof handlers.notificationclick === 'function', 'podsetnik: push i klik');
  });

  console.log((failed ? '✗ ' : '✓ ') + passed + ' provera prošlo' + (failed ? ', ' + failed + ' palo' : ''));
  process.exit(failed ? 1 : 0);
})();
