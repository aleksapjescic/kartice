/* Kartice — nalog i sinhronizacija (Supabase, vendor/supabase.min.js, podešavanje u config.js)
   Podaci se dele na stavke (špil, kartica, stanje ponavljanja, beleška, folder, dan statistike…),
   svaka je jedan red u tabeli items (supabase/schema.sql). Posle svakog čuvanja sync.js poredi svaku
   stavku sa poslednjom sinhronizovanom verzijom (otisak u sync.shadow); izmenjene se šalju sa vremenom
   izmene, nestale kao obrisane. Na serveru pobeđuje novija izmena, pa se izmene različitih kartica
   sa dva uređaja ne gaze. Fajlovi idu u privatni bucket 'files/<korisnik>/<fileId>'. */

var SYNC_META = 'syncMeta';
var SYNC_SETTINGS = ['font', 'size', 'lang', 'reduceMotion', 'pdfDark', 'pdfMode', 'newPerDay', 'maxReviews', 'retention', 'goal',
  'ttsAuto', 'ttsRate', 'aiProvider', 'aiModel', 'geminiModel', 'typeAnswer', 'remindAt'];
var sync = { client: null, user: null, meta: null, timer: null, running: null, again: false, status: '', error: '', sent: null };

function syncConfigured() { return typeof SUPABASE_URL === 'string' && !!SUPABASE_URL && typeof SUPABASE_ANON_KEY === 'string' && !!SUPABASE_ANON_KEY; }
async function syncClient() {
  if (!sync.client) {
    await loadScript('vendor/supabase.min.js');
    sync.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'kartice.auth' }
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
function syncSaveMeta() { return idb('state', 'readwrite', function (st) { return st.put(sync.meta, SYNC_META); }).catch(function () {}); }

/* ---------- sinhronizacija ---------- */
function syncAfterSave() {
  if (!sync.user || sync.applying) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(syncNow, 3000);
}
function syncNow() {
  if (!sync.user || !navigator.onLine) return Promise.resolve();
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
async function pullAll(c, since) {
  var rows = [], from = 0, page = 1000;
  for (;;) {
    var q = c.from('items').select('kind,id,data,updated,deleted,server_ts').order('server_ts', { ascending: true }).range(from, from + page - 1);
    // malo preklapanja: red upisan u transakciji koja se završila kasnije ne sme da se preskoči
    if (since) q = q.gt('server_ts', new Date(new Date(since).getTime() - 5000).toISOString());
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
        await backupPut('pre-sync', { t: Date.now(), data: JSON.parse(JSON.stringify(data)) });
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
    var r = await c.rpc('sync_push', { rows: part.map(function (x) { return { kind: x.kind, id: x.id, data: x.data, updated: x.updated, deleted: x.deleted }; }) });
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
  var uid = sync.user.id, ids = allFileIds(), sent = 0;
  for (var i = 0; i < ids.length && sent < 5; i++) {
    var id = ids[i];
    if (sync.meta.files[id]) continue;
    var rec = await idb('files', 'readonly', function (st) { return st.get(id); });
    if (!rec) continue;   // fajl je na drugom uređaju; preuzima se kad zatreba
    var up = await c.storage.from('files').upload(uid + '/' + id, new Blob([rec.buf], { type: rec.type || 'application/octet-stream' }), { upsert: true, contentType: rec.type || 'application/octet-stream' });
    if (up.error && !/exists/i.test(up.error.message || '')) throw up.error;
    sync.meta.files[id] = 1; sent++;
  }
  // fajlovi obrisanih beleški i kartica se brišu sa naloga jednom dnevno
  if (Date.now() - (sync.meta.gc || 0) > 864e5) {
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
    var c = await syncClient(), r = await c.storage.from('files').download(sync.user.id + '/' + id);
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
  try {
    var c = await syncClient(), r = await c.auth.getSession();
    sync.user = r.data && r.data.session ? r.data.session.user : null;
    c.auth.onAuthStateChange(function (ev, session) {
      var u = session ? session.user : null, was = sync.user;
      sync.user = u;
      if (u && (!was || was.id !== u.id)) syncLoadMeta().then(syncNow);
      if (ui.screen === 'settings') render(true);
    });
    if (sync.user) { await syncLoadMeta(); syncNow(); }
  } catch (e) { sync.error = (e && e.message) || ''; }
  setInterval(function () { if (sync.user && document.visibilityState === 'visible') syncNow(); }, 60000);
  window.addEventListener('online', function () { if (sync.user) syncNow(); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && sync.user) syncNow(); });
}
async function syncSendCode() {
  var el = document.getElementById('syncEmail'), email = el ? el.value.trim() : '';
  if (!/^\S+@\S+\.\S+$/.test(email)) { toast(t('Upiši ispravnu e-mail adresu.')); if (el) el.focus(); return; }
  try {
    var c = await syncClient(), r = await c.auth.signInWithOtp({ email: email, options: { shouldCreateUser: true } });
    if (r.error) throw r.error;
    sync.sent = email; render(true);
    var ce = document.getElementById('syncCode'); if (ce) ce.focus();
  } catch (e) { toast(t('Kod nije poslat: {m}', { m: (e && e.message) || '' })); }
}
async function syncVerify() {
  var el = document.getElementById('syncCode'), code = el ? el.value.replace(/\s+/g, '') : '';
  if (!/^\d{6,8}$/.test(code)) { toast(t('Upiši kod iz e-mail poruke.')); if (el) el.focus(); return; }
  try {
    var c = await syncClient(), r = await c.auth.verifyOtp({ email: sync.sent, token: code, type: 'email' });
    if (r.error) throw r.error;
    sync.sent = null;
    toast(t('Prijavljen si. Sinhronizujem…'));
  } catch (e) { toast(t('Kod nije ispravan ili je istekao.')); }
}
function syncSignOut() {
  modal({ title: t('Odjaviti se?'), text: t('Podaci ostaju na ovom uređaju, ali se više ne sinhronizuju dok se ponovo ne prijaviš.'), buttons: [
    { label: t('Odjavi se'), kind: 'danger', onClick: function () {
      syncClient().then(function (c) { return c.auth.signOut(); }).then(function () {
        sync.user = null; sync.meta = null;
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
function syncSettingsSection() {
  if (!syncConfigured()) return '';
  var body;
  if (sync.user) {
    body = '<p class="small-note">' + t('Prijavljen kao {e}', { e: esc(sync.user.email || '') }) + '</p>' +
      '<p class="small-note num" id="syncStatus">' + esc(syncStatusText()) + '</p>' +
      '<div class="row-btns even"><button class="btn small" data-act="syncNow">' + t('Sinhronizuj sada') + '</button>' +
      '<button class="btn small" data-act="syncSignOut">' + t('Odjavi se') + '</button></div>';
  } else if (sync.sent) {
    body = '<p class="small-note">' + t('Poslali smo kod na {e}. Upiši ga ovde (stiže za minut, proveri i neželjenu poštu).', { e: esc(sync.sent) }) + '</p>' +
      '<input class="input" id="syncCode" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" aria-label="' + esc(t('Kod iz e-mail poruke')) + '">' +
      '<div class="row-btns even"><button class="btn small primary" data-act="syncVerify">' + t('Prijavi se') + '</button>' +
      '<button class="btn small" data-act="syncReset">' + t('Druga adresa') + '</button></div>';
  } else {
    body = '<p class="small-note">' + t('Prijavi se istom e-mail adresom na telefonu i računaru i sve se sinhronizuje samo: kartice, napredak, beleške, fajlovi i statistika. Lozinka ne treba, stiže ti kod.') + '</p>' +
      '<input class="input" id="syncEmail" type="email" autocomplete="email" placeholder="ime@primer.com" aria-label="' + esc(t('E-mail adresa')) + '">' +
      '<button class="btn small primary" data-act="syncSendCode">' + t('Pošalji kod') + '</button>';
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
