/* Kartice — čuvanje podataka u IndexedDB
   Od verzije 13 glavni podaci (špilovi, beleške, napredak…) su u IndexedDB, a ne u localStorage,
   jer localStorage prima samo ~5 MB. Ista baza čuva i fajlove (PDF, Word, slike), istoriju odgovora
   i kopiju podataka napravljenu pre nadogradnje. */

var STORE_KEY = 'kartice.v1';   // ključ u localStorage iz verzija do 12
// ime baze na ovom uređaju; menja ga dbReset kad stara baza zaglavi (vidi app.js boot)
var FILE_DB = (function () { try { return localStorage.getItem('kartice.dbName') || 'kartice-files'; } catch (e) { return 'kartice-files'; } })();
var DB_VERSION = 2;
var TEXT_KEY = 'text:';         // tekst izvučen iz PDF-a ili Word-a za pretragu čuva se pod 'text:' + fileId
var STATE_KEY = 'data';

var dbPromise = null;
/* Safari (posebno aplikacija sa početnog ekrana na iPhone-u) ume da ne odgovori na prvi indexedDB.open
   dok se IndexedDB ne "probudi". Poznato zaobilaženje: pozivati indexedDB.databases() dok ne odgovori
   (najviše ~2 s), pa tek onda otvoriti bazu. Drugi pregledači odgovore odmah. */
function idbWake() {
  if (!indexedDB.databases) return Promise.resolve();
  return new Promise(function (res) {
    var tries = 0, timer = null;
    function ping() {
      tries++;
      indexedDB.databases().then(function () { clearInterval(timer); res(); }, function () { clearInterval(timer); res(); });
      if (tries >= 20) { clearInterval(timer); res(); }
    }
    timer = setInterval(ping, 100);
    ping();
  });
}
function db() {
  if (!dbPromise) {
    dbPromise = idbWake().then(function () { return new Promise(function (res, rej) {
      var r = indexedDB.open(FILE_DB, DB_VERSION);
      // stara veza (druga kartica ili ranija verzija) drži bazu: otvaranje čeka dok se ona ne zatvori
      r.onblocked = function () { if (typeof console !== 'undefined') console.warn('IndexedDB: čeka se zatvaranje stare veze'); };
      r.onupgradeneeded = function () {
        var d = r.result, have = d.objectStoreNames;
        if (!have.contains('files')) d.createObjectStore('files');
        if (!have.contains('state')) d.createObjectStore('state');
        if (!have.contains('backups')) d.createObjectStore('backups');
        if (!have.contains('log')) d.createObjectStore('log', { keyPath: 'id' }).createIndex('t', 't');
      };
      r.onsuccess = function () {
        var d = r.result;
        // druga kartica sa novijom verzijom aplikacije traži nadogradnju baze: ova veza se zatvara
        d.onversionchange = function () { d.close(); dbPromise = null; };
        res(d);
      };
      r.onerror = function () { dbPromise = null; rej(r.error); };
    }); });
  }
  return dbPromise;
}
/* Brisanje podataka sa ovog uređaja kad baza zaglavi: ne čeka se stara baza (i njeno brisanje ume da
   zaglavi), nego se prelazi na novu, praznu bazu pod drugim imenom, a stara se briše u pozadini.
   Prijava (localStorage 'kartice.auth') ostaje, pa sinhronizacija posle ponovnog učitavanja vrati sve sa naloga. */
function dbReset() {
  var old = FILE_DB;
  try {
    localStorage.setItem('kartice.dbName', 'kartice-files-' + Date.now().toString(36));
    localStorage.removeItem(STORE_KEY);
  } catch (e) {}
  try { indexedDB.deleteDatabase(old); } catch (e) {}
}
// glavni podaci sa vremenskim ograničenjem: ako baza ne odgovori, otvara se ponovo (jednom), a ne učitava se prazno
function stateGetPatient(ms) {
  function once() {
    return Promise.race([stateGet(), new Promise(function (res, rej) { setTimeout(function () { rej(new Error('idb-timeout')); }, ms); })]);
  }
  return once().catch(function (e) {
    if (!e || e.message !== 'idb-timeout') throw e;
    dbPromise = null;   // sledeći pokušaj otvara novu vezu
    return once();
  });
}
// jedna transakcija nad jednom prodavnicom; fn vraća zahtev čiji je rezultat odgovor
function idb(store, mode, fn) {
  return db().then(function (d) {
    return new Promise(function (res, rej) {
      var tx = d.transaction(store, mode), st = tx.objectStore(store), out;
      var r = fn(st);
      if (r) r.onsuccess = function () { out = r.result; };
      tx.oncomplete = function () { res(out); };
      tx.onerror = tx.onabort = function () { rej(tx.error); };
    });
  });
}

/* fajlovi (PDF, Word, slike) i tekst izvučen za pretragu */
function filePut(id, rec) { return idb('files', 'readwrite', function (st) { return st.put(rec, id); }); }
function fileGet(id) {
  return idb('files', 'readonly', function (st) { return st.get(id); }).then(function (rec) {
    // fajl dodat na drugom uređaju: preuzima se sa naloga kad zatreba (sync.js)
    if (rec || String(id).indexOf(TEXT_KEY) === 0 || typeof syncFetchFile !== 'function') return rec;
    return syncFetchFile(id);
  });
}
function fileDel(id) { return idb('files', 'readwrite', function (st) { return st.delete(id); }); }
function fileClear() { return idb('files', 'readwrite', function (st) { return st.clear(); }); }
function fileKeys() { return idb('files', 'readonly', function (st) { return st.getAllKeys(); }); }

/* glavni podaci */
function stateGet() { return idb('state', 'readonly', function (st) { return st.get(STATE_KEY); }); }
function statePut(d) { return idb('state', 'readwrite', function (st) { return st.put(d, STATE_KEY); }); }

/* istorija odgovora: { id, t, k (stavka), g (ocena 1–4, 0 = slobodno učenje), ms, st (stanje pre odgovora) } */
function logAdd(e) { return idb('log', 'readwrite', function (st) { return st.put(e); }); }
function logDel(id) { return idb('log', 'readwrite', function (st) { return st.delete(id); }); }
function logAll() { return idb('log', 'readonly', function (st) { return st.getAll(); }); }

/* kopije podataka (pre nadogradnje i pre vraćanja rezervne kopije) */
function backupPut(id, rec) { return idb('backups', 'readwrite', function (st) { return st.put(rec, id); }); }
function backupGet(id) { return idb('backups', 'readonly', function (st) { return st.get(id); }); }
function backupDel(id) { return idb('backups', 'readwrite', function (st) { return st.delete(id); }); }

/* Učitavanje: IndexedDB, a prvi put posle verzije 12 podaci iz localStorage.
   Vraća { data, from: 'idb' | 'local' | 'new' }. */
async function loadData() {
  var d = null;
  try { d = await stateGetPatient(6000); }
  catch (e) { if (e && e.message === 'idb-timeout') return { data: null, from: 'stuck' }; }
  if (d && Array.isArray(d.decks)) return { data: d, from: 'idb' };
  try {
    var raw = localStorage.getItem(STORE_KEY);
    if (raw) { d = JSON.parse(raw); if (d && Array.isArray(d.decks)) return { data: d, from: 'local' }; }
  } catch (e) {}
  return { data: { decks: [defaultDeck()], theme: 'auto', random: false, schema: SCHEMA }, from: 'new' };
}

/* ---------- migracije ----------
   data.schema: 1 (do verzije 12) → 2 (verzija 13: raspored ponavljanja, statistika, uređaj).
   Pre svake migracije pravi se kopija u 'backups' pod 'pre-v' + broj šeme, koja se čuva 30 dana. */
var SCHEMA = 2;
var BACKUP_DAYS = 30;
async function migrateData(d) {
  var from = d.schema || 1;
  if (from >= SCHEMA) return false;
  try { await backupPut('pre-v' + SCHEMA, { t: Date.now(), schema: from, data: JSON.parse(JSON.stringify(d)) }); } catch (e) {}
  if (from < 2) {
    d.rev = d.rev || {};
    d.days = d.days || {};
    // kartice koje su do sada bile "naučene" ulaze u raspored kao već naučene (srs.js)
    srsMigrateKnown(d);
  }
  d.schema = SCHEMA;
  return true;
}
// kopija pre nadogradnje: postoji li još (30 dana) i vraćanje
async function upgradeBackup() {
  try {
    var b = await backupGet('pre-v' + SCHEMA);
    if (!b) return null;
    if (Date.now() - b.t > BACKUP_DAYS * 864e5) { backupDel('pre-v' + SCHEMA).catch(function () {}); return null; }
    return b;
  } catch (e) { return null; }
}
