/* Kartice — nalog i sinhronizacija (Supabase, vendor/supabase.min.js, podešavanje u config.js)
   Podaci se dele na stavke (špil, kartica, stanje ponavljanja, beleška, folder, dan statistike…),
   svaka je jedan red u tabeli items (supabase/schema.sql). Posle svakog čuvanja sync.js poredi svaku
   stavku sa poslednjom sinhronizovanom verzijom (otisak u sync.shadow); izmenjene se šalju sa vremenom
   izmene, nestale kao obrisane. Na serveru pobeđuje novija izmena, pa se izmene različitih kartica
   sa dva uređaja ne gaze. Fajlovi idu u privatni bucket 'files/<korisnik>/<fileId>'. */

var SYNC_META = 'syncMeta';
var SYNC_SETTINGS = ['font', 'size', 'lang', 'reduceMotion', 'pdfDark', 'pdfMode', 'newPerDay', 'maxReviews', 'retention', 'goal',
  'ttsAuto', 'ttsRate', 'aiProvider', 'aiModel', 'geminiModel', 'typeAnswer', 'remindAt'];
// ai: stanje za AI preko ključa aplikacije iz touch_profile { role, blocked, on, used, limit } (null dok se ne učita)
// ready: da li se već zna da li postoji sesija (do tada se ne prikazuje ni aplikacija ni ekran za prijavu)
var sync = { client: null, user: null, meta: null, timer: null, running: null, again: false, status: '', error: '', ai: null, ready: false, opened: false };

function syncConfigured() { return typeof SUPABASE_URL === 'string' && !!SUPABASE_URL && typeof SUPABASE_ANON_KEY === 'string' && !!SUPABASE_ANON_KEY; }
async function syncClient() {
  if (!sync.client) {
    await loadScript('vendor/supabase.min.js');
    sync.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      // pkce: posle prijave Google-om Supabase vraća ?code= u adresi, a klijent ga sam razmeni za sesiju
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce', storageKey: 'kartice.auth' }
    });
  }
  return sync.client;
}

/* ---------- otisak stavki ---------- */
function fnv(s) {
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + s.length.toString(36);
}
function pick(o, keys) { var r = {}; keys.forEach(function (k) { if (o[k] !== undefined) r[k] = o[k]; }); return r; }
// sve stavke trenutnih podataka: { 'vrsta|id': { kind, id, data } }
function syncEntities() {
  var out = {};
  function put(kind, id, obj) { out[kind + '|' + id] = { kind: kind, id: id, data: obj }; }
  data.decks.forEach(function (d, i) {
    put('deck', d.id, { name: d.name || '', tag: d.tag || '', lang: d.lang || 'sr-RS', pos: i });
    d.cards.forEach(function (c, j) {
      put('card', d.id + '/' + c.id, Object.assign({ deck: d.id, pos: j }, c));
      if (d.known && d.known[c.id]) put('known', d.id + '/' + c.id, 1);
    });
  });
  data.quizzes.forEach(function (z, i) {
    put('quiz', z.id, { name: z.name || '', tag: z.tag || '', pos: i });
    z.questions.forEach(function (q, j) {
      put('qq', z.id + '/' + q.id, Object.assign({ quiz: z.id, pos: j }, q));
      if (z.known && z.known[q.id]) put('qknown', z.id + '/' + q.id, 1);
    });
  });
  data.notes.forEach(function (n) { put('note', n.id, n); });
  data.folders.forEach(function (f, i) { put('folder', f.id, { name: f.name, pos: i }); });
  Object.keys(data.rev).forEach(function (k) { put('rev', k, data.rev[k]); });
  Object.keys(data.days).forEach(function (dev) {
    Object.keys(data.days[dev]).forEach(function (day) { put('day', dev + '/' + day, data.days[dev][day]); });
  });
  put('settings', 'main', { theme: data.theme || 'auto', random: !!data.random, reverse: !!data.reverse, badges: data.badges || {}, s: pick(data.settings, SYNC_SETTINGS) });
  return out;
}
// šta je izmenjeno od poslednje sinhronizacije
function syncDiff() {
  var ent = syncEntities(), shadow = sync.meta.shadow, now = Date.now(), rows = [];
  Object.keys(ent).forEach(function (k) {
    var e = ent[k], h = fnv(JSON.stringify(e.data));
    if (shadow[k] !== h) rows.push({ key: k, h: h, kind: e.kind, id: e.id, data: e.data, updated: now, deleted: false });
  });
  Object.keys(shadow).forEach(function (k) {
    if (!ent[k]) { var p = k.indexOf('|'); rows.push({ key: k, h: null, kind: k.slice(0, p), id: k.slice(p + 1), data: null, updated: now, deleted: true }); }
  });
  return rows;
}

/* ---------- primena stavki sa servera ---------- */
function findDeck(id, create) {
  var d = data.decks.find(function (x) { return x.id === id; });
  if (!d && create) { d = { id: id, name: '', tag: '', cards: [], known: {}, lang: 'sr-RS' }; data.decks.push(d); }
  return d;
}
function findQuiz(id, create) {
  var z = data.quizzes.find(function (x) { return x.id === id; });
  if (!z && create) { z = { id: id, name: '', tag: '', questions: [], known: {} }; data.quizzes.push(z); }
  return z;
}
function upsert(list, obj) {
  var i = list.findIndex(function (x) { return x.id === obj.id; });
  if (i >= 0) list[i] = obj; else list.push(obj);
}
function strip(o, keys) { var r = Object.assign({}, o); keys.forEach(function (k) { delete r[k]; }); return r; }
function applyRow(r) {
  var o = r.data, del = r.deleted, p = r.id.split('/'), x;
  switch (r.kind) {
    case 'deck':
      if (del) { data.decks = data.decks.filter(function (d) { return d.id !== r.id; }); break; }
      x = findDeck(r.id, true); x.name = o.name; x.tag = o.tag; x.lang = o.lang; x._pos = o.pos; break;
    case 'card':
      x = findDeck(p[0], !del); if (!x) break;
      if (del) { x.cards = x.cards.filter(function (c) { return c.id !== p[1]; }); break; }
      var c = strip(o, ['deck', 'pos']); c._pos = o.pos; upsert(x.cards, c); break;
    case 'known':
      x = findDeck(p[0], !del); if (!x) break;
      if (del) delete x.known[p[1]]; else x.known[p[1]] = true; break;
    case 'quiz':
      if (del) { data.quizzes = data.quizzes.filter(function (z) { return z.id !== r.id; }); break; }
      x = findQuiz(r.id, true); x.name = o.name; x.tag = o.tag; x._pos = o.pos; break;
    case 'qq':
      x = findQuiz(p[0], !del); if (!x) break;
      if (del) { x.questions = x.questions.filter(function (q) { return q.id !== p[1]; }); break; }
      var q = strip(o, ['quiz', 'pos']); q._pos = o.pos; upsert(x.questions, q); break;
    case 'qknown':
      x = findQuiz(p[0], !del); if (!x) break;
      if (del) delete x.known[p[1]]; else x.known[p[1]] = true; break;
    case 'note':
      if (del) data.notes = data.notes.filter(function (n) { return n.id !== r.id; }); else upsert(data.notes, o); break;
    case 'folder':
      if (del) data.folders = data.folders.filter(function (f) { return f.id !== r.id; });
      else { x = data.folders.find(function (f) { return f.id === r.id; }); if (x) { x.name = o.name; x._pos = o.pos; } else data.folders.push({ id: r.id, name: o.name, _pos: o.pos }); }
      break;
    case 'rev':
      if (del) delete data.rev[r.id]; else data.rev[r.id] = o; break;
    case 'day':
      var dev = r.id.slice(0, r.id.indexOf('/')), day = r.id.slice(r.id.indexOf('/') + 1);
      if (dev === DEVICE_ID) break;   // svoje dnevne zbirove piše samo ovaj uređaj
      if (del) { if (data.days[dev]) delete data.days[dev][day]; }
      else { data.days[dev] = data.days[dev] || {}; data.days[dev][day] = o; }
      break;
    case 'settings':
      if (del || !o) break;
      data.theme = o.theme; data.random = o.random; data.reverse = o.reverse; data.badges = o.badges || {};
      Object.assign(data.settings, o.s || {});
      setLang(data.settings.lang);
      break;
  }
}
function byPos(a, b) { return (a._pos == null ? 1e9 : a._pos) - (b._pos == null ? 1e9 : b._pos); }
// pre primene: sve postojeće stavke dobiju trenutnu poziciju, a stavke sa servera svoju (applyRow)
function startApply() {
  function mark(l) { l.forEach(function (x, i) { x._pos = i; }); }
  mark(data.decks); mark(data.quizzes); mark(data.folders);
  data.decks.forEach(function (d) { mark(d.cards); });
  data.quizzes.forEach(function (z) { mark(z.questions); });
}
function finishApply() {
  [data.decks, data.quizzes, data.folders].forEach(function (l) { l.sort(byPos); });
  data.decks.forEach(function (d) { d.cards.sort(byPos); d.cards.forEach(function (c) { delete c._pos; }); delete d._pos; });
  data.quizzes.forEach(function (z) { z.questions.sort(byPos); z.questions.forEach(function (q) { delete q._pos; }); delete z._pos; });
  data.folders.forEach(function (f) { delete f._pos; });
  normalize(data);
}
// posle primene: otisak primenjenih stavki je ono što bi se sada izračunalo lokalno
function shadowAfterApply(keys) {
  var ent = syncEntities(), sh = sync.meta.shadow;
  keys.forEach(function (k) { if (ent[k]) sh[k] = fnv(JSON.stringify(ent[k].data)); else delete sh[k]; });
}

/* ---------- meta (otisci, vreme poslednjeg preuzimanja, poslati fajlovi) ---------- */
async function syncLoadMeta() {
  var m = null;
  try { m = await idb('state', 'readonly', function (st) { return st.get(SYNC_META); }); } catch (e) {}
  if (!m || m.uid !== sync.user.id) m = { uid: sync.user.id, shadow: {}, files: {}, lastPull: null, gc: 0, last: 0 };
  sync.meta = m;
}
function syncSaveMeta() {
  if (sync.as) return Promise.resolve();   // stanje tuđeg naloga se ne čuva u tvojoj bazi
  return idb('state', 'readwrite', function (st) { return st.put(sync.meta, SYNC_META); }).catch(function () {});
}

/* ---------- admin radi u nalogu korisnika ----------
   Tvoji podaci se sačuvaju i ostaju u lokalnoj bazi netaknuti; data u memoriji postaje materijal korisnika,
   preuzet sa njegovog naloga, a svaka izmena se šalje na njegov nalog (admin_pull / admin_push u schema.sql).
   Ništa od toga se ne upisuje u tvoju lokalnu bazu (saveNow, syncSaveMeta). Izlazak: pošalju se poslednje
   izmene i stranica se ponovo učita sa tvojim podacima. */
async function syncEnterAs(u) {
  if (!syncIsAdmin() || !u || !u.user_id) return;
  await Promise.resolve(saveNow());
  try { await syncNow(); } catch (e) {}
  var keep = data.settings;
  sync.as = { uid: u.user_id, email: u.email || u.name || '' };
  sync.meta = { uid: u.user_id, shadow: {}, files: {}, lastPull: null, gc: Date.now(), last: 0 };
  data = normalize({ decks: [], schema: SCHEMA, settings: Object.assign({}, keep) });
  ui.screen = 'home'; ui.manage = false; data.tab = 'decks';
  render();
  toast(t('Učitavam materijal korisnika {e}…', { e: sync.as.email }));
  await syncNow();
  render(true);
  if (sync.error) toast(t('Materijal nije učitan: {m}', { m: sync.error }));
}
async function syncExitAs() {
  if (!sync.as) return;
  toast(t('Šaljem poslednje izmene…'));
  try { await syncNow(); } catch (e) {}
  sync.as = null;
  location.reload();
}
function syncAsBanner() {
  if (!sync.as) return '';
  return '<div class="as-banner" role="status"><span>' + t('Radiš u nalogu: {e}', { e: esc(sync.as.email) }) + '</span>' +
    '<button type="button" data-act="exitAs">' + t('Izađi') + '</button></div>';
}

/* ---------- sinhronizacija ---------- */
function syncAfterSave() {
  if (!sync.user || sync.applying) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(syncNow, 3000);
}
function syncNow() {
  // posle nove prijave lokalni podaci se prvo brišu (syncFreshStart); do tada se ništa ne šalje na nalog
  if (!sync.user || !navigator.onLine || sync.resetting || syncFreshPending()) return Promise.resolve();
  if (sync.running) { sync.again = true; return sync.running; }
  sync.running = syncRun().catch(function (e) {
    sync.error = (e && e.message) || String(e);
  }).then(function () {
    sync.running = null;
    syncShowStatus();
    if (sync.again) { sync.again = false; return syncNow(); }
  });
  return sync.running;
}
// čiji se nalog sinhronizuje: svoj, ili korisnika u čijem nalogu admin radi (syncEnterAs)
function syncUid() { return sync.as ? sync.as.uid : sync.user.id; }
async function pullAll(c, since) {
  var rows = [], from = 0, page = 1000;
  // malo preklapanja: red upisan u transakciji koja se završila kasnije ne sme da se preskoči
  var after = since ? new Date(new Date(since).getTime() - 5000).toISOString() : null;
  for (;;) {
    var q;
    if (sync.as) q = c.rpc('admin_pull', { uid: sync.as.uid, since: after }).select('kind,id,data,updated,deleted,server_ts').range(from, from + page - 1);
    else {
      q = c.from('items').select('kind,id,data,updated,deleted,server_ts').order('server_ts', { ascending: true }).range(from, from + page - 1);
      if (after) q = q.gt('server_ts', after);
    }
    var r = await q;
    if (r.error) throw r.error;
    rows = rows.concat(r.data);
    if (r.data.length < page) break;
    from += page;
  }
  return rows;
}
// lokalni podaci koji još nisu menjani (samo početni špil, bez napretka)
function pristine() {
  return data.decks.length <= 1 && data.decks.every(function (d) { return d.id === 'mreze' && !Object.keys(d.known).length; }) &&
    !Object.keys(data.rev).length && !data.notes.length && !data.quizzes.length && !data.folders.length;
}
function askMerge() {
  return new Promise(function (res) {
    modal({
      title: t('Na nalogu već postoje podaci'),
      text: t('Na ovom uređaju i na nalogu postoje kartice ili beleške. Spoji ih (ništa se ne gubi) ili zameni podatke na ovom uređaju podacima sa naloga.'),
      buttons: [
        { label: t('Spoji'), kind: 'primary', onClick: function () { res('merge'); } },
        { label: t('Zameni podacima sa naloga'), kind: 'danger', onClick: function () { res('replace'); } },
        { label: t('Otkaži'), kind: 'cancel', onClick: function () { res(null); } }
      ]
    });
  });
}
async function syncRun() {
  var c = await syncClient();
  sync.error = ''; sync.status = 'busy'; syncShowStatus();
  var first = !sync.meta.lastPull;
  // 1. prvi put na ovom uređaju: prvo preuzmi sve sa naloga
  if (first) {
    var all = await pullAll(c, null), live = all.filter(function (r) { return !r.deleted; });
    if (live.length) {
      var mode = pristine() ? 'replace' : await askMerge();
      if (!mode) { sync.status = ''; return; }
      if (mode === 'replace') {
        if (!sync.as) await backupPut('pre-sync', { t: Date.now(), data: JSON.parse(JSON.stringify(data)) });
        data.decks = []; data.quizzes = []; data.notes = []; data.folders = []; data.rev = {};
        Object.keys(data.days).forEach(function (dev) { if (dev !== DEVICE_ID) delete data.days[dev]; });
      }
      sync.applying = true;
      startApply(); all.forEach(applyRow); finishApply();
      sync.applying = false;
      shadowAfterApply(all.map(function (r) { return r.kind + '|' + r.id; }));
      // u spajanju lokalne stavke koje se razlikuju ostaju bez otiska i šalju se u koraku 2
    }
    sync.meta.lastPull = maxTs(all, null) || new Date(0).toISOString();
    await saveNow();
  }
  // 2. slanje izmena
  var rows = syncDiff();
  for (var i = 0; i < rows.length; i += 500) {
    var part = rows.slice(i, i + 500);
    var payload = part.map(function (x) { return { kind: x.kind, id: x.id, data: x.data, updated: x.updated, deleted: x.deleted }; });
    var r = sync.as ? await c.rpc('admin_push', { uid: sync.as.uid, rows: payload }) : await c.rpc('sync_push', { rows: payload });
    if (r.error) throw r.error;
    part.forEach(function (x) { if (x.deleted) delete sync.meta.shadow[x.key]; else sync.meta.shadow[x.key] = x.h; });
  }
  // 3. preuzimanje izmena sa drugih uređaja
  if (!first || rows.length) {
    var inc = await pullAll(c, sync.meta.lastPull);
    var ent = syncEntities(), changed = inc.filter(function (r) {
      var k = r.kind + '|' + r.id, e = ent[k];
      if (r.deleted) return !!e;
      return !e || fnv(JSON.stringify(e.data)) !== fnv(JSON.stringify(r.data));
    });
    if (changed.length) {
      sync.applying = true;
      startApply(); changed.forEach(applyRow); finishApply();
      sync.applying = false;
      shadowAfterApply(changed.map(function (r) { return r.kind + '|' + r.id; }));
      await saveNow();
      syncRerender();
    }
    sync.meta.lastPull = maxTs(inc, sync.meta.lastPull);
  }
  // 4. fajlovi
  await syncFiles(c);
  sync.meta.last = Date.now(); sync.status = '';
  await syncSaveMeta();
}
function maxTs(rows, cur) {
  var m = cur;
  rows.forEach(function (r) { if (!m || r.server_ts > m) m = r.server_ts; });
  return m;
}
// osveži ekran posle izmena sa drugog uređaja, ali ne usred učenja ili pisanja
function syncRerender() {
  if (/^(cards|quizPlay|noteEdit|edit|quizEdit|aiReview)$/.test(ui.screen) || document.querySelector('.modal-back')) return;
  render(true);
}

/* ---------- fajlovi ---------- */
async function syncFiles(c) {
  var uid = syncUid(), ids = allFileIds(), sent = 0;
  for (var i = 0; i < ids.length && sent < 5; i++) {
    var id = ids[i];
    if (sync.meta.files[id]) continue;
    var rec = await idb('files', 'readonly', function (st) { return st.get(id); });
    if (!rec) continue;   // fajl je na drugom uređaju; preuzima se kad zatreba
    var up = await c.storage.from('files').upload(uid + '/' + id, new Blob([rec.buf], { type: rec.type || 'application/octet-stream' }), { upsert: true, contentType: rec.type || 'application/octet-stream' });
    if (up.error && !/exists/i.test(up.error.message || '')) throw up.error;
    sync.meta.files[id] = 1; sent++;
  }
  // fajlovi obrisanih beleški i kartica se brišu sa naloga jednom dnevno (u tuđem nalogu nikad)
  if (!sync.as && Date.now() - (sync.meta.gc || 0) > 864e5) {
    var keep = {}; ids.forEach(function (x) { keep[x] = 1; });
    var ls = await c.storage.from('files').list(uid, { limit: 1000 });
    if (!ls.error && ls.data) {
      var del = ls.data.map(function (o) { return o.name; }).filter(function (n) { return !keep[n]; });
      if (del.length) await c.storage.from('files').remove(del.map(function (n) { return uid + '/' + n; }));
      del.forEach(function (n) { delete sync.meta.files[n]; });
    }
    sync.meta.gc = Date.now();
  }
}
// fajl kog nema na ovom uređaju (dodat na drugom) preuzima se kad se otvori (store.js fileGet)
async function syncFetchFile(id) {
  if (!sync.user || !navigator.onLine) return undefined;
  try {
    var c = await syncClient(), r = await c.storage.from('files').download(syncUid() + '/' + id);
    if (r.error || !r.data) return undefined;
    var rec = { name: id, type: r.data.type, buf: await r.data.arrayBuffer() };
    await filePut(id, rec);
    sync.meta.files[id] = 1;
    return rec;
  } catch (e) { return undefined; }
}

/* ---------- pokretanje i prijava ---------- */
async function syncBoot() {
  if (!syncConfigured()) return;
  var back = syncOAuthReturn();
  // Sačuvana prijava otvara aplikaciju odmah; getSession ume da čeka mrežu (istekao token, a na iPhone-u
  // aplikacija sa početnog ekrana ume da visi i po minut), pa se ono završava u pozadini.
  var stored = syncStoredUser();
  if (stored && !back.code) { sync.user = stored; sync.ready = true; render(true); }
  // a ako nema sačuvane prijave, čekanje traje najviše nekoliko sekundi
  setTimeout(function () { if (!sync.ready) { sync.ready = true; render(true); } }, back.code ? 15000 : 4000);
  try {
    var c = await syncClient(), r = await c.auth.getSession();
    var sess = r.data && r.data.session;
    // greška pri osvežavanju (bez interneta) ne odjavljuje: ostaje sačuvana prijava
    sync.user = sess ? sess.user : (r.error && stored ? stored : null);
    syncCleanUrl();
    // nova prijava (povratak sa Google-a): prvo brisanje lokalnih podataka, pa ponovno učitavanje
    if (syncFreshStart()) return;
    c.auth.onAuthStateChange(function (ev, session) {
      var u = session ? session.user : null, was = sync.user;
      sync.user = u;
      if (u && syncFreshPending()) return;   // nova prijava: syncFreshStart briše lokalne podatke
      if (u && (!was || was.id !== u.id)) { syncLoadMeta().then(syncNow); syncLoadProfile(); syncLogOpen(); }
      if (!u) sync.ai = null;
      // promena naloga otvara ili zatvara ekran za prijavu
      if (!!u !== !!was || /^(settings|admin|adminUser)$/.test(ui.screen)) render(true);
    });
    sync.ready = true;
    if (sync.user) { await syncLoadMeta(); syncNow(); syncLoadProfile(); syncLogOpen(); }
    render(true);
    if (back.error) toast(t('Prijava sa Google-om nije uspela: {m}', { m: back.error }));
    else if (back.code && sync.user) toast(t('Prijavljen si. Sinhronizujem…'));
  } catch (e) { sync.error = (e && e.message) || ''; sync.ready = true; syncCleanUrl(); render(true); }
  setInterval(function () { if (sync.user && document.visibilityState === 'visible') syncNow(); }, 60000);
  window.addEventListener('online', function () { if (sync.user) syncNow(); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && sync.user) syncNow(); });
}
// povratak sa Google prijave: ?code=… (uspeh) ili ?error_description=… (otkazano ili greška)
function syncOAuthReturn() {
  var q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.replace(/^#/, ''));
  return { code: q.get('code'), error: q.get('error_description') || h.get('error_description') || '' };
}
function syncCleanUrl() {
  if (/[?&](code|error|error_description)=/.test(location.search) || /error_description=/.test(location.hash)) {
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
  }
}
// Prijava Google-om: stranica ode na Google i vrati se ovde (Supabase → Authentication → URL Configuration)
/* Nova prijava na uređaju: lokalni podaci se brišu i sve se preuzima sa naloga. Podaci na nalogu se ne diraju:
   ništa od starih lokalnih podataka (prethodni korisnik, podrazumevani podaci) ne stiže na nalog, jer se
   sinhronizacija ne pokreće dok se baza ne zameni novom (syncNow). Oznaka važi 30 minuta od početka prijave. */
var FRESH_KEY = 'kartice.freshLogin';
function syncMarkFresh() { try { localStorage.setItem(FRESH_KEY, String(Date.now())); } catch (e) {} }
function syncFreshPending() {
  try { var ts = +localStorage.getItem(FRESH_KEY) || 0; return ts > 0 && Date.now() - ts < 30 * 60000; } catch (e) { return false; }
}
// vraća true ako je pokrenuto brisanje (stranica se ponovo učitava)
function syncFreshStart() {
  if (!sync.user || !syncFreshPending()) return false;
  sync.resetting = true;
  try { localStorage.removeItem(FRESH_KEY); } catch (e) {}
  app.innerHTML = '<div class="screen login-gate"><div class="head login-head"><span class="eyebrow">' + t('Učenje kartica') + '</span><h1>' + t('Kartice') + '</h1></div>' +
    '<p class="sub">' + t('Preuzimam tvoje podatke sa naloga…') + '</p></div>';
  dbReset();
  setTimeout(function () { location.reload(); }, 300);
  return true;
}
/* Prijava mejlom i lozinkom, bez potvrde na mejl (Supabase → Email: "Confirm email" isključeno),
   pa nalog radi odmah po registraciji. */
function syncCreds() {
  var e = document.getElementById('syncEmail'), p = document.getElementById('syncPass');
  var email = e ? e.value.trim() : '', pass = p ? p.value : '';
  if (!/^\S+@\S+\.\S+$/.test(email)) { toast(t('Upiši ispravnu e-mail adresu.')); if (e) e.focus(); return null; }
  if (pass.length < 6) { toast(t('Lozinka mora da ima bar 6 znakova.')); if (p) p.focus(); return null; }
  return { email: email, password: pass };
}
function syncAuthError(e, create) {
  var code = (e && e.code) || '', msg = (e && e.message) || '';
  if (code === 'invalid_credentials' || /invalid login/i.test(msg)) return t('Pogrešan mejl ili lozinka. Ako si se ranije prijavljivao Google-om, prvo postavi lozinku u Podešavanjima na uređaju gde si prijavljen.');
  if (code === 'user_already_exists' || /already registered/i.test(msg)) return t('Nalog sa tom adresom već postoji. Prijavi se lozinkom.');
  if (code === 'weak_password') return t('Lozinka je preslaba. Izaberi dužu.');
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit') return t('Previše pokušaja. Sačekaj malo pa probaj ponovo.');
  return create ? t('Nalog nije napravljen: {m}', { m: msg }) : t('Prijava nije uspela: {m}', { m: msg });
}
async function syncPassLogin(create) {
  var cr = syncCreds(); if (!cr || sync.loggingIn) return;
  sync.loggingIn = true;
  try {
    await Promise.resolve(saveNow());
    syncMarkFresh();   // nova prijava: lokalni podaci se brišu i preuzimaju sa naloga (syncFreshStart)
    var c = await syncClient(), r = create ? await c.auth.signUp(cr) : await c.auth.signInWithPassword(cr);
    if (r.error) throw r.error;
    var sess = r.data && r.data.session;
    if (!sess) throw { code: create ? 'user_already_exists' : 'invalid_credentials' };
    sync.user = sess.user;
    if (!syncFreshStart()) { toast(t('Prijavljen si. Sinhronizujem…')); render(true); }
  } catch (e) {
    try { localStorage.removeItem(FRESH_KEY); } catch (x) {}
    toast(syncAuthError(e, create));
  } finally { sync.loggingIn = false; }
}
function syncSignIn() { return syncPassLogin(false); }
function syncSignUp() { return syncPassLogin(true); }
// lozinka za nalog napravljen preko Google-a (ili promena lozinke), dok je korisnik prijavljen
function syncSetPassword() {
  modal({ title: t('Lozinka za prijavu'), text: t('Sa adresom {e} i ovom lozinkom prijavljuješ se na drugim uređajima. Najmanje 6 znakova.', { e: (sync.user && sync.user.email) || '' }),
    input: { type: 'password', placeholder: t('Nova lozinka'), autocomplete: 'new-password' },
    buttons: [{ label: t('Sačuvaj'), kind: 'primary', onClick: function (v) {
      v = v || '';
      if (v.length < 6) { toast(t('Lozinka mora da ima bar 6 znakova.')); return false; }
      syncClient().then(function (c) { return c.auth.updateUser({ password: v }); }).then(function (r) {
        if (r.error) throw r.error;
        toast(t('Lozinka je sačuvana.'));
      }).catch(function (e) { toast(t('Lozinka nije sačuvana: {m}', { m: (e && e.message) || '' })); });
    } }, { label: t('Otkaži'), kind: 'cancel' }] });
}
// uloga, blokada i dnevni limit za AI preko ključa aplikacije; usput beleži poslednju aktivnost
async function syncLoadProfile() {
  try {
    var c = await syncClient(), r = await c.rpc('touch_profile');
    if (r.error) throw r.error;
    sync.ai = r.data;
  } catch (e) { sync.ai = null; }
  if (/^(settings|admin)$/.test(ui.screen)) render(true);
}
function syncIsAdmin() { return !!(sync.user && sync.ai && sync.ai.role === 'admin'); }
function syncSignOut() {
  modal({ title: t('Odjaviti se?'), text: t('Sve što je sinhronizovano ostaje na nalogu. Pri sledećoj prijavi podaci na ovom uređaju se brišu i preuzimaju sa naloga.'), buttons: [
    { label: t('Odjavi se'), kind: 'danger', onClick: function () {
      syncClient().then(function (c) { return c.auth.signOut(); }).then(function () {
        sync.user = null; sync.meta = null; sync.ai = null;
        idb('state', 'readwrite', function (st) { return st.delete(SYNC_META); }).catch(function () {});
        render(true);
      });
    } }, { label: t('Otkaži'), kind: 'cancel' }] });
}
function syncStatusText() {
  if (sync.status === 'busy') return t('Sinhronizujem…');
  if (sync.error) return t('Sinhronizacija nije uspela: {m}', { m: sync.error });
  if (!navigator.onLine) return t('Nema interneta; izmene čekaju.');
  if (sync.meta && sync.meta.last) {
    var min = Math.round((Date.now() - sync.meta.last) / 60000);
    return min < 1 ? t('Sinhronizovano upravo sada.') : t('Sinhronizovano pre {n} min.', { n: min });
  }
  return '';
}
function syncShowStatus() { var el = document.getElementById('syncStatus'); if (el) el.textContent = syncStatusText(); }
// korisnik iz sesije koju supabase-js čuva u localStorage (ključ storageKey iz syncClient)
function syncStoredUser() {
  try {
    var s = JSON.parse(localStorage.getItem('kartice.auth') || 'null');
    return s && s.user && s.user.id && s.refresh_token ? s.user : null;
  } catch (e) { return null; }
}
/* ---------- vreme u aplikaciji (za admin statistiku) ----------
   Broji se vreme dok je aplikacija na ekranu i korisnik je nešto radio u poslednja 3 minuta (dodir, klik,
   taster, skrol), bilo da uči, čita beleške ili pravi kviz. Sabira se svakih 10 s, a na nalog (log_time)
   šalje jednom u minuti i kad se aplikacija skloni. Ranije se merilo samo vreme odgovaranja na kartice. */
var appTime = { acc: 0, lastTick: 0, lastAct: 0, started: false };
var APP_IDLE = 180000;
function appTimeStart() {
  if (appTime.started) return;
  appTime.started = true;
  appTime.lastTick = appTime.lastAct = Date.now();
  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(function (ev) {
    document.addEventListener(ev, function () { appTime.lastAct = Date.now(); }, { passive: true, capture: true });
  });
  setInterval(appTimeTick, 10000);
  setInterval(appTimeFlush, 60000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { appTimeTick(); appTimeFlush(); }
    else appTime.lastTick = appTime.lastAct = Date.now();
  });
}
function appTimeTick() {
  var now = Date.now(), dt = now - appTime.lastTick;
  appTime.lastTick = now;
  if (document.visibilityState !== 'visible' || now - appTime.lastAct > APP_IDLE) return;
  appTime.acc += Math.min(dt, 15000);   // posle uspavanog telefona se ne računa ceo razmak
}
function appTimeFlush() {
  if (!sync.user || appTime.acc < 1000 || !navigator.onLine) return;
  var ms = Math.round(Math.min(appTime.acc, 300000));
  appTime.acc -= ms;
  syncClient().then(function (c) { return c.rpc('log_time', { ms: ms }); })
    .then(function (r) { if (r && r.error) appTime.acc += ms; }, function () { appTime.acc += ms; });
}
// jedno otvaranje aplikacije po učitavanju stranice, za statistiku korišćenja u admin panelu
function syncLogOpen() {
  if (sync.opened) return;
  sync.opened = true;
  syncClient().then(function (c) { return c.rpc('log_open'); }).catch(function () {});
  appTimeStart();
}

/* ---------- obavezna prijava ----------
   Kad je Supabase podešen, aplikacija se koristi samo sa nalogom: dok se ne zna da li postoji sesija,
   prikazuje se kratko učitavanje, a bez naloga ekran za prijavu. Sesija se pamti, pa se prijava traži
   samo prvi put na uređaju i posle odjave; sačuvana sesija radi i bez interneta. */
function syncGate() {
  if (!syncConfigured()) return null;
  if (!sync.ready) return 'wait';
  return sync.user ? null : 'login';
}
function viewLoginGate(gate) {
  var head = '<div class="head login-head"><span class="eyebrow">' + t('Učenje kartica') + '</span><h1>' + t('Kartice') + '</h1></div>';
  if (gate === 'wait') return '<div class="screen login-gate">' + head + '<p class="sub">' + t('Učitavam…') + '</p></div>';
  return '<div class="screen login-gate">' + head +
    '<p class="sub">' + t('Prijavi se da nastaviš. Kartice, beleške i napredak čuvaju se na tvom nalogu i rade na svakom uređaju.') + '</p>' +
    (navigator.onLine ? '' : '<p class="small-note">' + t('Nema interneta. Za prijavu je potrebna veza.') + '</p>') +
    '<div class="stack">' + syncLoginBody(false) + '</div>' +
    '<p class="small-note"><a href="privacy.html" target="_blank" rel="noopener">' + t('Politika privatnosti') + '</a></p>' +
    '</div>';
}
// prijava mejlom i lozinkom; intro=true dodaje objašnjenje (u podešavanjima)
function syncLoginBody(intro) {
  return (intro ? '<p class="small-note">' + t('Prijavi se istim nalogom na telefonu i računaru i sve se sinhronizuje samo: kartice, napredak, beleške, fajlovi i statistika. Sa nalogom AI radi i bez tvog ključa.') + '</p>' : '') +
    '<input class="input" id="syncEmail" type="email" autocomplete="email" autocapitalize="off" placeholder="ime@primer.com" aria-label="' + esc(t('E-mail adresa')) + '">' +
    '<input class="input" id="syncPass" type="password" autocomplete="current-password" placeholder="' + esc(t('Lozinka')) + '" aria-label="' + esc(t('Lozinka')) + '">' +
    '<div class="row-btns even"><button class="btn small primary" data-act="syncSignIn">' + t('Prijavi se') + '</button>' +
    '<button class="btn small" data-act="syncSignUp">' + t('Napravi nalog') + '</button></div>' +
    '<p class="small-note">' + t('Nov si? Upiši mejl i lozinku (bar 6 znakova) i pritisni Napravi nalog. Potvrda na mejl ne treba.') + '</p>';
}

function syncSettingsSection() {
  if (!syncConfigured()) return '';
  var body;
  if (sync.user) {
    body = '<p class="small-note">' + t('Prijavljen kao {e}', { e: esc(sync.user.email || '') }) + '</p>' +
      '<p class="small-note num" id="syncStatus">' + esc(syncStatusText()) + '</p>' +
      '<div class="row-btns even"><button class="btn small" data-act="syncNow">' + t('Sinhronizuj sada') + '</button>' +
      '<button class="btn small" data-act="syncSignOut">' + t('Odjavi se') + '</button></div>' +
      '<button class="btn small" data-act="syncSetPassword">' + t('Postavi lozinku') + '</button>' +
      (syncIsAdmin() ? '<button class="btn small" data-act="openAdmin">' + t('Admin panel') + '</button>' : '') +
      '<p class="small-note">' + t('Administrator aplikacije može da vidi i menja tvoje kartice, kvizove i beleške i da ti pripremi novi materijal.') + ' <a href="privacy.html" target="_blank" rel="noopener">' + t('Politika privatnosti') + '</a></p>';
  } else {
    body = syncLoginBody(true);
  }
  return '<div class="section"><h2>' + t('Nalog i sinhronizacija') + '</h2>' + body + '</div>';
}

/* ---------- podsetnik (Web Push) ----------
   Uređaj se pretplati na obaveštenja, a pretplata i vreme (po lokalnom vremenu) idu u tabelu push_subs.
   Supabase Edge Function 'reminders' (supabase/functions/reminders) proverava svakih 15 minuta i šalje
   obaveštenje samo ako tog dana ima kartica za ponavljanje. Na iPhone-u radi kad je aplikacija na
   početnom ekranu (iOS 16.4 i noviji). */
function remindSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
function remindConfigured() { return syncConfigured() && typeof VAPID_PUBLIC_KEY === 'string' && !!VAPID_PUBLIC_KEY; }
function b64uToBytes(s) {
  var pad = '='.repeat((4 - s.length % 4) % 4), b = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/')), out = new Uint8Array(b.length);
  for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
async function remindSave(at) {
  var reg = await navigator.serviceWorker.ready;
  var sub = await reg.pushManager.getSubscription() ||
    await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(VAPID_PUBLIC_KEY) });
  var c = await syncClient(), tz = 'Europe/Belgrade';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch (e) {}
  var r = await c.from('push_subs').upsert({ endpoint: sub.endpoint, user_id: sync.user.id, sub: sub.toJSON(), remind_at: at, tz: tz }, { onConflict: 'endpoint' });
  if (r.error) throw r.error;
}
async function remindOn() {
  if (!remindSupported()) { toast(t('Ovaj uređaj ne podržava obaveštenja. Na iPhone-u prvo dodaj aplikaciju na početni ekran.')); return; }
  if (!sync.user) { toast(t('Za podsetnik se prvo prijavi na nalog.')); return; }
  var perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast(t('Obaveštenja nisu dozvoljena. Dozvoli ih u podešavanjima telefona.')); return; }
  try {
    await remindSave(data.settings.remindAt || '19:00');
    data.settings.remind = true; save(); render(true);
    toast(t('Podsetnik je uključen: svaki dan u {h}.', { h: data.settings.remindAt }));
  } catch (e) { toast(t('Podsetnik nije uključen: {m}', { m: (e && e.message) || '' })); }
}
async function remindOff() {
  try {
    var reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
    if (sub) {
      if (sync.user) { var c = await syncClient(); await c.from('push_subs').delete().eq('endpoint', sub.endpoint); }
      await sub.unsubscribe();
    }
  } catch (e) {}
  data.settings.remind = false; save(); render(true);
}
async function remindTime(at) {
  if (!/^\d\d:\d\d$/.test(at)) return;
  data.settings.remindAt = at; save();
  if (data.settings.remind && sync.user) { try { await remindSave(at); toast(t('Podsetnik je pomeren na {h}.', { h: at })); } catch (e) {} }
}
function remindSection() {
  if (!remindConfigured()) return '';
  var on = !!data.settings.remind;
  return '<div class="section"><h2>' + t('Podsetnik') + '</h2>' +
    '<button class="toggle-row" role="switch" aria-checked="' + on + '" data-act="remindToggle"><span>' + t('Podseti me da učim') +
      '<small>' + t('Obaveštenje stiže samo ako tog dana ima kartica za ponavljanje.') + '</small></span><span class="switch" aria-hidden="true"></span></button>' +
    '<div class="field"><label class="label" for="remindTime">' + t('Vreme') + '</label>' +
      '<input class="input" id="remindTime" type="time" value="' + esc(data.settings.remindAt || '19:00') + '"></div>' +
    (sync.user ? '' : '<p class="small-note">' + t('Podsetnik radi preko naloga, pa se prvo prijavi gore.') + '</p>') +
    '</div>';
}
