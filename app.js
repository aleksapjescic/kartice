/* Kartice — logika aplikacije
   Zavisi od data.js (DEFAULT_CARDS, BUILTIN_NOTES) i i18n.js (t, pw, setLang).
   Pri svakom objavljivanju: povećati APP_VERSION, isti broj upisati u version.json
   i u ?v= parametre u index.html. */

var APP_VERSION = 9;
var STORE_KEY = 'kartice.v1';

/* ---------- pomoćne funkcije ---------- */
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
function shuffled(a) { a = a.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function fmtDate(ts) {
  try { return new Date(ts).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; }
}
function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  var mb = bytes / 1048576;
  var s = mb >= 1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return LANG === 'en' ? s : s.replace('.', ',');
}
function loadScript(src) {
  loadScript.cache = loadScript.cache || {};
  if (!loadScript.cache[src]) {
    loadScript.cache[src] = new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.onload = res;
      s.onerror = function () { delete loadScript.cache[src]; rej(new Error('script ' + src)); };
      document.head.appendChild(s);
    });
  }
  return loadScript.cache[src];
}

/* ---------- podaci ---------- */
function defaultDeck() {
  return {
    id: 'mreze', name: 'Računarske mreže', tag: 'Pitanja za test', known: {},
    cards: DEFAULT_CARDS.map(function (c, i) { return { id: 'c' + i, n: c[0], q: c[1], a: c[2] }; })
  };
}
function load() {
  try {
    var raw = localStorage.getItem(STORE_KEY);
    if (raw) { var d = JSON.parse(raw); if (d && Array.isArray(d.decks)) return d; }
  } catch (e) {}
  return { decks: [defaultDeck()], theme: 'auto', random: false };
}
var data = load();
if (!Array.isArray(data.notes)) data.notes = [];
if (!Array.isArray(data.folders)) data.folders = [];
data.notes.forEach(function (n) { if (!n.type) n.type = 'text'; if (n.folderId === undefined) n.folderId = null; });
if (data.tab !== 'notes') data.tab = 'decks';
data.settings = Object.assign({ font: 'system', size: 'm', lang: 'sr', reduceMotion: false, pdfDark: false }, data.settings || {});
setLang(data.settings.lang);

var saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}
function saveNow() {
  clearTimeout(saveTimer);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) {}
}

/* ---------- fajlovi (PDF, DOCX) u IndexedDB; localStorage je premali za njih ---------- */
var FILE_DB = 'kartice-files', FILE_STORE = 'files';
var dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise(function (res, rej) {
      var r = indexedDB.open(FILE_DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(FILE_STORE); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { dbPromise = null; rej(r.error); };
    });
  }
  return dbPromise;
}
function idbReq(mode, fn) {
  return db().then(function (d) {
    return new Promise(function (res, rej) {
      var tx = d.transaction(FILE_STORE, mode), st = tx.objectStore(FILE_STORE), out;
      var r = fn(st);
      if (r) r.onsuccess = function () { out = r.result; };
      tx.oncomplete = function () { res(out); };
      tx.onerror = tx.onabort = function () { rej(tx.error); };
    });
  });
}
function filePut(id, rec) { return idbReq('readwrite', function (st) { return st.put(rec, id); }); }
function fileGet(id) { return idbReq('readonly', function (st) { return st.get(id); }); }
function fileDel(id) { return idbReq('readwrite', function (st) { return st.delete(id); }); }
function fileClear() { return idbReq('readwrite', function (st) { return st.clear(); }); }

// fajl obrisane beleške briše se tek kad istekne "Vrati"
var pendingFileDeletes = {};
function scheduleFileDelete(fileId) {
  if (!fileId) return;
  clearTimeout(pendingFileDeletes[fileId]);
  pendingFileDeletes[fileId] = setTimeout(function () { delete pendingFileDeletes[fileId]; fileDel(fileId).catch(function () {}); }, 7000);
}
function cancelFileDelete(fileId) { clearTimeout(pendingFileDeletes[fileId]); delete pendingFileDeletes[fileId]; }

/* ---------- stanje ekrana (ne čuva se) ---------- */
var ui = { screen: 'home', deckId: null, order: [], i: 0, flipped: false, dir: 'R', tick: 0, manage: false, fs: false, noteId: null, folderId: null, from: null };
var lastScreen = null, lastTick = -1;

function deck() { return data.decks.find(function (d) { return d.id === ui.deckId; }) || null; }
function cardById(d, id) { return d.cards.find(function (c) { return c.id === id; }); }
function knownCount(d) { return d.cards.filter(function (c) { return d.known[c.id]; }).length; }
function unknownIds(d) { return d.cards.filter(function (c) { return !d.known[c.id]; }).map(function (c) { return c.id; }); }
function pct(d) { return d.cards.length ? Math.round(knownCount(d) / d.cards.length * 100) : 0; }
function cardNo(d, c) { return c.n || String(d.cards.indexOf(c) + 1); }

function noteById(id) {
  return BUILTIN_NOTES.find(function (x) { return x.id === id; }) || data.notes.find(function (x) { return x.id === id; }) || null;
}
function isBuiltin(id) { return BUILTIN_NOTES.some(function (x) { return x.id === id; }); }
function folderById(id) { return data.folders.find(function (f) { return f.id === id; }) || null; }
function notesIn(folderId) {
  return data.notes.filter(function (n) { return (n.folderId || null) === (folderId || null); })
    .sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
}

var ICON = {
  back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  prev: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  next: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>',
  more: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  gear: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  folder: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  fsOn: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  fsOff: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>'
};

function seg(name, opts, current) {
  return '<div class="seg" style="--n:' + opts.length + '">' + opts.map(function (o) {
    return '<button data-act="' + name + '" data-arg="' + o[0] + '" aria-pressed="' + (o[0] === current) + '"' + (o[2] ? ' class="' + o[2] + '"' : '') + '>' + o[1] + '</button>';
  }).join('') + '</div>';
}
function bar(p, cls) {
  return '<div class="bar ' + (cls || '') + '" role="progressbar" aria-label="' + esc(t('Naučena pitanja')) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(p) + '"><span style="width:' + p + '%"></span></div>';
}
function backBtn(act, label) {
  return '<button class="nav-back" data-act="' + act + '">' + ICON.back + '<span>' + esc(label) + '</span></button>';
}

/* ---------- ekrani: početna ---------- */
function viewHome() {
  var total = data.decks.reduce(function (s, d) { return s + d.cards.length; }, 0);
  var n = data.decks.length;
  if (!n) ui.manage = false;
  var noName = t('Bez naziva');
  var list = data.decks.map(function (d) {
    var p = pct(d);
    var meta = '<span class="deck-meta">' + d.cards.length + ' ' + pw(d.cards.length, 'kartica') + ' · ' + t('{p}% naučeno', { p: p }) + '</span>';
    if (ui.manage) {
      return '<div class="deck managed"><div class="deck-info"><span class="deck-name">' + esc(d.name || noName) + '</span>' + meta + '</div>' +
        '<button class="del-btn" data-act="delDeck" data-arg="' + d.id + '">' + t('Obriši') + '</button></div>';
    }
    return '<button class="deck" data-act="open" data-arg="' + d.id + '">' +
      '<span class="deck-name">' + esc(d.name || noName) + '</span>' + meta + bar(p, 'thin') + '</button>';
  }).join('');
  var notesTab = data.tab === 'notes';
  var nn = BUILTIN_NOTES.length + data.notes.length;
  var sub = notesTab
    ? (nn ? nn + ' ' + pw(nn, 'beleška') + (data.folders.length ? ' · ' + data.folders.length + ' ' + pw(data.folders.length, 'folder') : '') : t('Nemaš nijednu belešku.'))
    : (n ? n + ' ' + pw(n, 'špil') + ' · ' + total + ' ' + pw(total, 'kartica') : t('Nemaš nijedan špil. Napravi prvi.'));
  return '<div class="screen home">' +
    '<div class="head"><span class="eyebrow">' + t('Učenje kartica') + '</span>' +
    '<div class="head-row"><h1>' + t('Kartice') + '</h1><div class="head-actions">' +
      (!notesTab && n ? '<button class="link" data-act="manage">' + (ui.manage ? t('Gotovo') : t('Izmeni')) + '</button>' : '') +
      '<button class="icon-btn" data-act="settings" aria-label="' + esc(t('Podešavanja')) + '" title="' + esc(t('Podešavanja')) + '">' + ICON.gear + '</button>' +
    '</div></div>' +
    '<span class="sub num">' + sub + '</span></div>' +
    seg('tab', [['decks', t('Špilovi')], ['notes', t('Beleške')]], data.tab) +
    (notesTab ? viewNotesRoot()
      : '<div class="decks">' + list + (ui.manage ? '' : '<button class="deck add-deck btn" data-act="newDeck">' + t('+ Novi špil') + '</button>') + '</div>') +
    '<div class="spacer"></div>' +
    '<div class="field"><span class="label">' + t('Tema') + '</span>' + themeSeg() + '</div>' +
    '</div>';
}
function themeSeg() {
  return seg('theme', [['auto', t('Sistem')], ['tamna', t('Tamna')], ['svetla', t('Svetla')], ['plava', t('Plava')]], data.theme);
}

/* ---------- ekrani: beleške i folderi ---------- */
var FILE_ACCEPT = '.txt,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function plainPreview(text) {
  var line = String(text || '').split('\n').map(function (l) { return l.replace(/^#+\s*|^[-•*]\s+/, '').trim(); })
    .filter(function (l) { return l; })[0];
  return line || t('Prazna beleška');
}
function noteItem(x, opts) {
  opts = opts || {};
  var builtin = isBuiltin(x.id);
  var badge = builtin ? '<span class="badge">' + t('Materijal') + '</span>'
    : x.type === 'pdf' ? '<span class="badge pdf">PDF</span>'
    : x.type === 'docx' ? '<span class="badge docx">DOCX</span>' : '';
  var preview = x.type === 'pdf' ? (x.pages ? x.pages + ' ' + pw(x.pages, 'strana') : t('PDF dokument')) + (x.lastPage > 1 ? ' · ' + t('stao si na {n}. strani', { n: x.lastPage }) : '')
    : x.type === 'docx' ? t('Word dokument') + (x.size ? ' · ' + fmtSize(x.size) : '')
    : plainPreview(x.body);
  var folder = opts.showFolder && x.folderId && folderById(x.folderId);
  return '<button class="note-item" data-act="openNote" data-arg="' + x.id + '">' +
    '<span class="note-title">' + esc(x.title || t('Bez naslova')) + '</span>' +
    '<span class="note-preview">' + esc(preview) + '</span>' +
    '<span class="note-meta">' + badge + (builtin ? (x.subject ? '<span>' + esc(x.subject) + '</span>' : '') : '<span>' + esc(fmtDate(x.updated)) + '</span>') +
      (folder ? '<span>· ' + esc(folder.name) + '</span>' : '') + '</span>' +
    '</button>';
}
function noteList(arr, opts) {
  return '<div class="note-list">' + arr.map(function (x) { return noteItem(x, opts); }).join('') + '</div>';
}
function addButtons(folderId) {
  return '<div class="row-btns"><button class="btn add-deck" data-act="newNote" data-arg="' + (folderId || '') + '">' + t('+ Nova beleška') + '</button>' +
    '<button class="btn" data-act="importFile" data-arg="' + (folderId || '') + '">' + t('Uvezi fajl') + '</button></div>' +
    '<input type="file" id="noteFile" accept="' + FILE_ACCEPT + '" multiple hidden>';
}
function viewNotesRoot() {
  var root = notesIn(null);
  var total = BUILTIN_NOTES.length + data.notes.length;
  var folders = data.folders.map(function (f) {
    var c = notesIn(f.id).length;
    return '<button class="folder" data-act="openFolder" data-arg="' + f.id + '">' + ICON.folder +
      '<span class="folder-name">' + esc(f.name) + '</span><span class="folder-count">' + c + ' ' + pw(c, 'beleška') + '</span></button>';
  }).join('');
  return (total > 3 || data.folders.length ? '<input class="input search" id="noteSearch" type="search" placeholder="' + esc(t('Pretraži beleške')) + '" aria-label="' + esc(t('Pretraži beleške')) + '" autocomplete="off">' : '') +
    '<div id="notesMain" class="stack" style="gap:20px">' +
      '<div class="section"><span class="label">' + t('Folderi') + '</span><div class="folder-grid">' + folders +
        '<button class="folder add" data-act="newFolder">' + t('+ Novi folder') + '</button></div></div>' +
      (BUILTIN_NOTES.length ? '<div class="section"><span class="label">' + t('Materijali') + '</span>' + noteList(BUILTIN_NOTES) + '</div>' : '') +
      '<div class="section"><span class="label">' + t('Beleške van foldera') + '</span>' +
        (root.length ? noteList(root) : '<p class="empty-note">' + t('Ovde nema beleški. Napiši novu ili uvezi .txt, PDF ili Word (.docx) fajl.') + '</p>') +
        addButtons(null) +
      '</div>' +
    '</div>' +
    '<div id="noteResults" class="section" hidden></div>';
}
function viewFolder() {
  var f = folderById(ui.folderId);
  var list = notesIn(f.id);
  return '<div class="screen folder-screen">' +
    '<div class="topbar">' + backBtn('toNotes', t('Beleške')) +
      '<div class="topbar-actions"><button class="link" data-act="renameFolder">' + t('Preimenuj') + '</button>' +
      '<button class="link danger" data-act="delFolder">' + t('Obriši') + '</button></div></div>' +
    '<div class="head" style="padding-top:0"><span class="eyebrow">' + t('Folder') + '</span><h1>' + esc(f.name) + '</h1>' +
      '<span class="sub num">' + list.length + ' ' + pw(list.length, 'beleška') + '</span></div>' +
    (list.length ? noteList(list) : '<p class="empty-note">' + t('Folder je prazan. Napiši belešku, uvezi fajl ili premesti postojeću belešku ovde.') + '</p>') +
    addButtons(f.id) +
    '</div>';
}
function backLabel() {
  var f = ui.from && folderById(ui.from);
  return f ? f.name : t('Beleške');
}
function noteActions(x) {
  return '<div class="topbar-actions">' +
    '<button class="link" data-act="moveNote">' + t('Premesti') + '</button>' +
    '<button class="link" data-act="downloadNote">' + (x.type === 'text' ? t('Preuzmi .txt') : t('Preuzmi')) + '</button></div>';
}

// jednostavan prikaz teksta: # naslov, ## podnaslov, - stavka, prazan red = novi pasus
function fmtNote(text) {
  var out = [], para = [], list = [];
  function flushPara() { if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; } }
  function flushList() { if (list.length) { out.push('<ul>' + list.map(function (l) { return '<li>' + l + '</li>'; }).join('') + '</ul>'); list = []; } }
  String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach(function (raw) {
    var line = raw.trim(), m;
    if (!line) { flushPara(); flushList(); return; }
    if ((m = line.match(/^##\s+(.*)$/))) { flushPara(); flushList(); out.push('<h3>' + esc(m[1]) + '</h3>'); return; }
    if ((m = line.match(/^#\s+(.*)$/))) { flushPara(); flushList(); out.push('<h2>' + esc(m[1]) + '</h2>'); return; }
    if ((m = line.match(/^[-•*]\s+(.*)$/))) { flushPara(); list.push(esc(m[1])); return; }
    flushList(); para.push(esc(line));
  });
  flushPara(); flushList();
  return out.join('') || '<p class="empty-note">' + t('Ova beleška je prazna.') + '</p>';
}
function viewNoteRead() {
  var x = noteById(ui.noteId);
  return '<div class="screen note-read">' +
    '<div class="topbar">' + backBtn('backFromNote', t('Beleške')) +
    '<button class="link" data-act="downloadNote">' + t('Preuzmi .txt') + '</button></div>' +
    '<div class="head" style="padding-top:0"><span class="eyebrow">' + t('Materijal') + (x.subject ? ' · ' + esc(x.subject) : '') + '</span>' +
    '<h1 class="read-title">' + esc(x.title) + '</h1></div>' +
    '<div class="reader">' + fmtNote(x.body) + '</div>' +
    '</div>';
}
function viewNoteEdit() {
  var x = noteById(ui.noteId);
  return '<div class="screen note-edit">' +
    '<div class="topbar">' + backBtn('backFromNote', backLabel()) + noteActions(x) + '</div>' +
    '<input class="input title-input" id="noteTitle" data-note="title" value="' + esc(x.title) + '" placeholder="' + esc(t('Naslov')) + '" aria-label="' + esc(t('Naslov beleške')) + '" autocomplete="off">' +
    '<textarea class="input note-body" id="noteBody" data-note="body" placeholder="' + esc(t('Piši ovde…')) + '" aria-label="' + esc(t('Tekst beleške')) + '">' + esc(x.body) + '</textarea>' +
    '<div class="note-foot"><span id="noteSaved">' + t('Sačuvano automatski · {d}', { d: fmtDate(x.updated) }) + '</span>' +
    '<button class="link danger" data-act="delNote">' + t('Obriši belešku') + '</button></div>' +
    '</div>';
}
function viewDocx() {
  var x = noteById(ui.noteId);
  return '<div class="screen doc-read">' +
    '<div class="topbar">' + backBtn('backFromNote', backLabel()) + noteActions(x) + '</div>' +
    '<div class="head" style="padding-top:0"><span class="eyebrow">' + t('Word dokument') + (x.size ? ' · ' + fmtSize(x.size) : '') + '</span>' +
    '<h1 class="read-title">' + esc(x.title) + '</h1></div>' +
    '<div class="reader" id="docxBody"><p class="empty-note">' + t('Učitavam dokument…') + '</p></div>' +
    '<div class="note-foot"><span></span><button class="link danger" data-act="delNote">' + t('Obriši dokument') + '</button></div>' +
    '</div>';
}
function viewPdf() {
  var x = noteById(ui.noteId);
  var n = x.pages || 1, cur = Math.min(x.lastPage || 1, n);
  return '<div class="screen pdf-screen">' +
    '<div class="topbar pdf-top">' + backBtn('backFromNote', backLabel()) +
      '<span class="pdf-title">' + esc(x.title) + '</span>' +
      '<button class="icon-btn" data-act="pdfMenu" aria-label="' + esc(t('Opcije')) + '">' + ICON.more + '</button></div>' +
    '<div class="book-wrap' + (data.settings.pdfDark ? ' dark-pages' : '') + '" id="bookWrap"><span class="book-loading">' + t('Učitavam PDF…') + '</span></div>' +
    '<div class="pdf-bottom">' +
      '<button class="btn" data-act="pdfPrev" aria-label="' + esc(t('Prethodna strana')) + '">' + ICON.prev + '</button>' +
      '<input type="range" id="pdfRange" min="1" max="' + n + '" value="' + cur + '" aria-label="' + esc(t('Strana')) + '">' +
      '<span class="pdf-count" id="pdfCount">' + cur + ' / ' + n + '</span>' +
      '<button class="btn" data-act="pdfNext" aria-label="' + esc(t('Sledeća strana')) + '">' + ICON.next + '</button>' +
    '</div></div>';
}

/* ---------- ekrani: špil, učenje, kraj, uređivanje ---------- */
function viewDeck() {
  var d = deck();
  var kc = knownCount(d), total = d.cards.length, unk = total - kc, p = pct(d);
  return '<div class="screen deck-wide">' +
    '<div class="topbar">' + backBtn('home', t('Špilovi')) + '</div>' +
    '<div class="deck-menu">' +
      '<div class="col">' +
        '<div class="head" style="padding-top:0"><span class="eyebrow">' + esc(d.tag || t('Špil')) + '</span><h1>' + esc(d.name || t('Bez naziva')) + '</h1>' +
        '<span class="sub num">' + total + ' ' + pw(total, 'kartica') + '</span></div>' +
        '<div class="panel"><div class="row-between"><span style="font-size:15px;color:var(--muted)">' + t('Naučeno') + '</span>' +
        '<span style="font-size:15px"><b style="font-weight:600">' + p + '%</b><span style="color:var(--muted)"> · ' + kc + ' / ' + total + '</span></span></div>' + bar(p) + '</div>' +
      '</div>' +
      '<div class="col">' +
        '<div class="field"><span class="label">' + t('Redosled') + '</span>' + seg('order', [['seq', t('Po redu')], ['rnd', t('Nasumično')]], data.random ? 'rnd' : 'seq') + '</div>' +
        '<div class="stack">' +
          (total === 0 ? '<p class="sub" style="margin:0;font-size:15px">' + t('Špil je prazan. Dodaj prve kartice.') + '</p>' : '') +
          '<button class="btn primary" data-act="startAll"' + (total ? '' : ' disabled') + '>' + t('Počni sve kartice') + '</button>' +
          (kc > 0 && unk > 0 ? '<button class="btn" data-act="startUnknown">' + t('Samo nenaučene ({n})', { n: unk }) + '</button>' : '') +
          '<button class="btn" data-act="edit">' + t('Izmeni kartice') + '</button>' +
          '<div style="display:flex;justify-content:center;flex-wrap:wrap;gap:4px 16px">' +
            (kc > 0 ? '<button class="link" data-act="reset">' + t('Resetuj napredak') + '</button>' : '') +
            '<button class="link danger" data-act="delDeck">' + t('Obriši špil') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div></div>';
}
function viewStudy() {
  var d = deck();
  var c = cardById(d, ui.order[ui.i]);
  var no = cardNo(d, c);
  var kc = knownCount(d), total = d.cards.length, p = pct(d);
  var anim = ui.tick !== lastTick ? ' in-' + ui.dir : '';
  var top = '<div class="study-top">' +
    '<div class="topbar">' + backBtn('toDeck', t('Meni')) +
    '<span class="num" style="font-size:15px;color:var(--muted)">' + (ui.i + 1) + ' / ' + ui.order.length + '</span></div>' +
    '<div class="bar hair"><span style="width:' + (ui.i / ui.order.length * 100) + '%"></span></div>' +
    '<div style="display:flex;flex-direction:column;gap:6px"><div class="known-row"><span>' + t('Naučeno') + '</span><span><b>' + p + '%</b> · ' + kc + ' / ' + total + '</span></div>' + bar(p, 'thin') + '</div>' +
    '</div>';
  var body, actions, keys;
  if (!ui.flipped) {
    body = '<button class="card front' + anim + '" data-act="flip" aria-label="' + esc(t('Okreni karticu')) + '">' +
      '<span class="eyebrow">' + t('Pitanje {n}', { n: esc(no) }) + '</span>' +
      '<span class="q-big">' + esc(c.q) + '</span>' +
      '<span class="hint"><span class="touch-only">' + t('Dodirni za odgovor') + '</span><span class="mouse-only">' + t('Klikni za odgovor') + '</span></span></button>';
    actions = '<div class="actions front">' +
      '<button class="btn icon" data-act="prev" aria-label="' + esc(t('Prethodna kartica')) + '"' + (ui.i === 0 ? ' disabled' : '') + '>' + ICON.prev + '</button>' +
      '<button class="btn primary" data-act="flip">' + t('Prikaži odgovor') + '</button></div>';
    keys = '<div class="keys"><span><kbd>' + t('Razmak') + '</kbd> ' + t('okreni') + '</span><span><kbd>←</kbd> ' + t('prethodna') + '</span><span><kbd>Esc</kbd> ' + t('meni') + '</span></div>';
  } else {
    var ans = c.a && c.a.trim()
      ? '<span>' + esc(c.a) + '</span>'
      : '<span class="empty">' + t('Za ovo pitanje nema tekstualnog odgovora (zadatak je crtež).') + '</span>';
    body = '<div class="card back">' +
      '<button class="q-small" data-act="flip"><span class="eyebrow">' + t('Pitanje {n}', { n: esc(no) }) + '</span><span>' + esc(c.q) + '</span></button>' +
      '<div class="divider"></div>' +
      '<div class="answer-scroll"><button class="answer" data-act="flip" aria-label="' + esc(t('Vrati na pitanje')) + '">' + ans + '</button></div>' +
      '<span class="hint"><span class="touch-only">' + t('Prevuci desno ako znaš, levo ako ne znaš') + '</span><span class="mouse-only">' + t('Klikni karticu za pitanje') + '</span></span></div>';
    actions = '<div class="actions back">' +
      '<button class="btn" data-act="no">' + t('Ne znam') + '</button>' +
      '<button class="btn primary" data-act="yes">' + t('Znam') + '</button></div>';
    keys = '<div class="keys"><span><kbd>1</kbd> ' + t('ili') + ' <kbd>←</kbd> ' + t('ne znam') + '</span><span><kbd>2</kbd> ' + t('ili') + ' <kbd>→</kbd> ' + t('znam') + '</span><span><kbd>' + t('Razmak') + '</kbd> ' + t('pitanje') + '</span></div>';
  }
  return '<div class="screen study">' + top + '<div class="card-area" id="cardArea">' + body + '</div>' + actions + keys + '</div>';
}
function viewDone() {
  var d = deck();
  var kc = knownCount(d), total = d.cards.length, unk = total - kc, p = pct(d);
  return '<div class="screen done">' +
    '<div style="display:flex;flex-direction:column;gap:8px">' +
      '<span class="eyebrow">' + t('Krug završen') + '</span><span class="big-pct">' + p + '%</span>' +
      '<span class="sub">' + t('Naučeno {k} od {n}.', { k: kc, n: total }) + ' ' + (unk === 0 ? t('Znaš sva pitanja.') : t('Ostalo je još {n}.', { n: unk })) + '</span>' +
      '<div style="margin-top:8px">' + bar(p) + '</div>' +
    '</div>' +
    '<div class="stack">' +
      (unk > 0 ? '<button class="btn primary" data-act="startUnknown">' + t('Ponovi nenaučene ({n})', { n: unk }) + '</button>' : '') +
      '<button class="btn' + (unk > 0 ? '' : ' primary') + '" data-act="toDeck">' + t('Glavni meni') + '</button>' +
    '</div></div>';
}
function viewEdit() {
  var d = deck();
  var cards = d.cards.map(function (c) {
    return '<div class="ed-card">' +
      '<div class="ed-top"><span class="eyebrow">' + t('Pitanje {n}', { n: esc(cardNo(d, c)) }) + '</span>' +
      '<button class="link danger" data-act="delCard" data-arg="' + c.id + '">' + t('Obriši') + '</button></div>' +
      '<textarea class="input ed-q" id="q-' + c.id + '" data-field="q" data-id="' + c.id + '" rows="1" placeholder="' + esc(t('Pitanje')) + '" aria-label="' + esc(t('Pitanje')) + '">' + esc(c.q) + '</textarea>' +
      '<textarea class="input" id="a-' + c.id + '" data-field="a" data-id="' + c.id + '" rows="2" placeholder="' + esc(t('Odgovor')) + '" aria-label="' + esc(t('Odgovor')) + '">' + esc(c.a) + '</textarea>' +
      '</div>';
  }).join('');
  return '<div class="screen edit">' +
    '<div class="topbar">' + backBtn('toDeck', t('Gotovo')) +
    '<button class="link" data-act="export"' + (d.cards.length ? '' : ' disabled') + '>' + t('Kopiraj kao tekst') + '</button></div>' +
    '<div class="field"><label class="label" for="deckName">' + t('Naziv špila') + '</label>' +
    '<input class="input name-input" id="deckName" data-deck="name" value="' + esc(d.name) + '" placeholder="' + esc(t('Naziv špila')) + '" autocomplete="off"></div>' +
    '<div class="field"><label class="label" for="deckTag">' + t('Podnaslov') + '</label>' +
    '<input class="input" id="deckTag" data-deck="tag" value="' + esc(d.tag || '') + '" placeholder="' + esc(t('npr. Pitanja za test')) + '" autocomplete="off"></div>' +
    '<details class="import"' + (d.cards.length ? '' : ' open') + '><summary>' + t('Uvezi više kartica iz teksta') + '</summary><div class="body">' +
      '<p>' + t('Nalepi tekst. Kartice odvoji praznim redom: prvi red je pitanje, ostali redovi su odgovor. Radi i format pitanje[Tab]odgovor po redu, kao izvoz iz Quizleta.') + '</p>' +
      '<textarea class="input" id="importText" rows="6" placeholder="' + esc(t('Šta je IP adresa?\nJedinstvena adresa uređaja u mreži.\n\nŠta je ruter?\nUređaj koji povezuje mreže.')) + '"></textarea>' +
      '<button class="btn small primary" data-act="import">' + t('Dodaj kartice') + '</button>' +
    '</div></details>' +
    '<div class="row-between"><span class="label">' + t('Kartice ({n})', { n: d.cards.length }) + '</span></div>' +
    '<div class="ed-list">' + cards + '</div>' +
    '<button class="btn add-deck" data-act="addCard">' + t('+ Nova kartica') + '</button>' +
    '</div>';
}

/* ---------- ekran: podešavanja ---------- */
function toggleRow(key, label, note) {
  var on = !!data.settings[key];
  return '<button class="toggle-row" role="switch" aria-checked="' + on + '" data-act="toggleSetting" data-arg="' + key + '">' +
    '<span>' + label + (note ? '<small>' + note + '</small>' : '') + '</span><span class="switch" aria-hidden="true"></span></button>';
}
function viewSettings() {
  var s = data.settings;
  return '<div class="screen settings">' +
    '<div class="topbar">' + backBtn('home', t('Nazad')) + '</div>' +
    '<div class="head" style="padding-top:0"><h1>' + t('Podešavanja') + '</h1></div>' +
    '<div class="section"><h2>' + t('Izgled') + '</h2>' +
      '<div class="field"><span class="label">' + t('Tema') + '</span>' + themeSeg() + '</div>' +
      '<div class="field"><span class="label">' + t('Font') + '</span>' +
        seg('setFont', [['system', t('Sistemski'), 'font-system'], ['serif', 'Serif', 'font-serif'], ['rounded', t('Zaobljeni'), 'font-rounded'], ['mono', 'Mono', 'font-mono']], s.font) + '</div>' +
      '<div class="field"><span class="label">' + t('Veličina teksta u karticama i beleškama') + '</span>' +
        seg('setSize', [['s', t('Mala')], ['m', t('Srednja')], ['l', t('Velika')], ['xl', t('Najveća')]], s.size) + '</div>' +
      '<div class="preview"><b>' + t('Šta su računarske mreže?') + '</b><span>' + t('Ovako izgleda tekst kartice i beleške sa izabranim fontom i veličinom.') + '</span></div>' +
    '</div>' +
    '<div class="section"><h2>' + t('Jezik') + '</h2>' +
      seg('setLang', [['sr', 'Latinica'], ['sr-Cyrl', 'Ћирилица'], ['en', 'English']], s.lang) +
      '<p class="small-note">' + t('Jezik menja natpise u aplikaciji. Tvoje kartice i beleške ostaju kako si ih napisao.') + '</p>' +
    '</div>' +
    '<div class="section"><h2>' + t('Učenje i čitanje') + '</h2>' +
      toggleRow('reduceMotion', t('Smanji animacije'), t('Kartice i stranice se menjaju bez pokreta.')) +
      toggleRow('pdfDark', t('Tamne PDF stranice'), t('PDF se prikazuje sa tamnom pozadinom i svetlim tekstom.')) +
    '</div>' +
    '<div class="section"><h2>' + t('Podaci') + '</h2>' +
      '<p class="small-note" id="storageInfo">' + t('Računam zauzeće…') + '</p>' +
      '<button class="btn small" data-act="backupExport">' + t('Napravi rezervnu kopiju') + '</button>' +
      '<button class="btn small" data-act="backupImport">' + t('Vrati iz rezervne kopije') + '</button>' +
      '<input type="file" id="backupFile" accept=".json,application/json" hidden>' +
      '<p class="small-note">' + t('Kopija sadrži sve špilove, napredak, beleške, foldere i fajlove. Sačuvaj je u Fajlove ili na računar; tako možeš da preneseš sve na drugi telefon ili pregledač.') + '</p>' +
    '</div>' +
    '<div class="section"><h2>' + t('O aplikaciji') + '</h2>' +
      '<p class="small-note">' + t('Kartice · verzija {v}', { v: APP_VERSION }) + '</p>' +
    '</div>' +
    '</div>';
}

/* ---------- prikaz ---------- */
var app = document.getElementById('app');
var VIEWS = { home: viewHome, deck: viewDeck, cards: viewStudy, done: viewDone, edit: viewEdit, folder: viewFolder,
  noteRead: viewNoteRead, noteEdit: viewNoteEdit, docx: viewDocx, pdf: viewPdf, settings: viewSettings };

function applyTheme() {
  var b = document.body, s = data.settings;
  b.classList.toggle('t-dark', data.theme === 'tamna');
  b.classList.toggle('t-light', data.theme === 'svetla');
  b.classList.toggle('t-blue', data.theme === 'plava');
  ['serif', 'rounded', 'mono'].forEach(function (f) { b.classList.toggle('f-' + f, s.font === f); });
  ['s', 'l', 'xl'].forEach(function (z) { b.classList.toggle('ts-' + z, s.size === z); });
  b.classList.toggle('reduce-motion', !!s.reduceMotion);
  document.documentElement.lang = LANG === 'en' ? 'en' : LANG === 'sr-Cyrl' ? 'sr-Cyrl' : 'sr-Latn';
  // boja statusne trake na telefonu prati temu
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', getComputedStyle(b).getPropertyValue('--bg').trim() || '#1C1B1A');
}
function render(keepScroll) {
  if (ui.screen !== 'pdf' || lastScreen !== 'pdf') destroyBook();
  // ekran čiji podaci više ne postoje vraća na početnu
  if ((ui.screen === 'folder' && !folderById(ui.folderId)) ||
      (/^(noteRead|noteEdit|docx|pdf)$/.test(ui.screen) && !noteById(ui.noteId)) ||
      (/^(deck|cards|done|edit)$/.test(ui.screen) && !deck())) ui.screen = 'home';
  applyTheme();
  document.body.classList.toggle('has-fs', !!document.fullscreenEnabled);
  var cur = app.querySelector('.screen');
  var prevScroll = keepScroll && cur ? cur.scrollTop : 0;
  var html = VIEWS[ui.screen]();
  if (ui.screen !== lastScreen && ui.screen !== 'cards') html = html.replace('class="screen', 'class="screen enter');
  var fsLabel = esc(ui.fs ? t('Izađi iz celog ekrana') : t('Ceo ekran'));
  var fsBtn = document.fullscreenEnabled
    ? '<button class="fs" data-act="fs" aria-label="' + fsLabel + '" title="' + fsLabel + '">' + (ui.fs ? ICON.fsOff : ICON.fsOn) + '</button>' : '';
  app.innerHTML = fsBtn + html;
  // iOS Safari ne zna za field-sizing, pa polja za tekst rastu preko JS-a
  app.querySelectorAll('textarea').forEach(autosize);
  if (keepScroll) app.querySelector('.screen').scrollTop = prevScroll;
  lastScreen = ui.screen;
  if (ui.screen === 'cards') lastTick = ui.tick;
  if (ui.screen === 'pdf') mountPdf();
  if (ui.screen === 'docx') mountDocx();
  if (ui.screen === 'settings') fillStorageInfo();
  if (pendingUpdate) setTimeout(applyUpdate, 0);
}

function toast(msg, actionLabel, action) {
  var old = document.querySelector('.toast'); if (old) old.remove();
  var el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status');
  var span = document.createElement('span'); span.textContent = msg; el.appendChild(span);
  if (actionLabel) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = actionLabel;
    b.addEventListener('click', function () { el.remove(); action(); });
    el.appendChild(b);
  }
  document.body.appendChild(el);
  setTimeout(function () { el.remove(); }, actionLabel ? 6000 : 2400);
}

/* Prozor: potvrda, unos teksta ili izbor.
   o = { title, text, input: { value, placeholder }, buttons: [{ label, kind: 'danger'|'primary'|'cancel'|'current', onClick(value) }] }
   onClick koji vrati false ostavlja prozor otvoren. */
function modal(o) {
  var back = document.createElement('div');
  back.className = 'modal-back';
  var html = '<div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="mTitle">' +
    '<h2 id="mTitle">' + esc(o.title) + '</h2>' + (o.text ? '<p>' + esc(o.text) + '</p>' : '') +
    (o.input ? '<input class="input" id="mInput" value="' + esc(o.input.value || '') + '" placeholder="' + esc(o.input.placeholder || '') + '" autocomplete="off">' : '') +
    '<div class="modal-btns">' + o.buttons.map(function (b, i) {
      return '<button type="button" data-i="' + i + '" class="m-' + (b.kind || 'plain') + '"' + (b.kind === 'current' ? ' disabled' : '') + '>' + esc(b.label) + '</button>';
    }).join('') + '</div></div>';
  back.innerHTML = html;
  var prevFocus = document.activeElement;
  var input = back.querySelector('#mInput');
  function close() { document.removeEventListener('keydown', onKey, true); back.remove(); if (prevFocus && prevFocus.focus) try { prevFocus.focus({ preventScroll: true }); } catch (e) {} }
  function run(i) {
    var b = o.buttons[i];
    if (b.kind === 'cancel' || !b.onClick) { close(); return; }
    var r = b.onClick(input ? input.value : undefined);
    if (r !== false) close();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && input && document.activeElement === input) {
      e.preventDefault();
      var i = o.buttons.findIndex(function (b) { return b.kind !== 'cancel'; });
      if (i >= 0) run(i);
    }
  }
  back.addEventListener('click', function (e) {
    if (e.target === back) { close(); return; }
    var btn = e.target.closest('button[data-i]');
    if (btn && !btn.disabled) run(+btn.dataset.i);
  });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(back);
  if (input) { input.focus(); input.select(); }
  else { var c = back.querySelector('.m-cancel') || back.querySelector('button'); if (c) c.focus(); }
  return close;
}

/* ---------- špilovi ---------- */
function askDeleteDeck(id) {
  var d = data.decks.find(function (x) { return x.id === id; });
  if (!d) return;
  modal({
    title: t('Obrisati špil?'),
    text: t('Da li ste sigurni da hoćete da obrišete špil „{name}“? Biće obrisane sve kartice i napredak u njemu.', { name: d.name || t('Bez naziva') }),
    buttons: [{ label: t('Obriši špil'), kind: 'danger', onClick: function () { deleteDeck(id); } }, { label: t('Nemoj da brišeš'), kind: 'cancel' }]
  });
}
function deleteDeck(id) {
  var idx = data.decks.findIndex(function (d) { return d.id === id; });
  if (idx < 0) return;
  var removed = data.decks.splice(idx, 1)[0];
  save();
  ui.screen = 'home'; render(true);
  toast(t('Špil „{name}“ je obrisan', { name: removed.name || t('Bez naziva') }), t('Vrati'), function () {
    data.decks.splice(Math.min(idx, data.decks.length), 0, removed);
    save(); if (ui.screen === 'home') render(true);
  });
}
function begin(ids) {
  if (!ids.length) return;
  ui.order = data.random ? shuffled(ids) : ids.slice();
  ui.i = 0; ui.flipped = false; ui.dir = 'R'; ui.tick++; ui.screen = 'cards';
  render();
}
function go(next) {
  if (next >= ui.order.length) { ui.screen = 'done'; ui.flipped = false; render(); return; }
  if (next < 0) return;
  ui.dir = next < ui.i ? 'L' : 'R'; ui.i = next; ui.flipped = false; ui.tick++;
  render();
}
function mark(knew) {
  var d = deck(), id = ui.order[ui.i];
  if (knew) d.known[id] = true; else delete d.known[id];
  save(); go(ui.i + 1);
}
function flip() { ui.flipped = !ui.flipped; render(); }

function parseImport(text) {
  text = text.replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  var lines = text.split('\n');
  var tabbed = lines.filter(function (l) { return l.indexOf('\t') > 0; }).length;
  if (tabbed && tabbed >= lines.filter(function (l) { return l.trim(); }).length / 2) {
    return lines.filter(function (l) { return l.trim(); }).map(function (l) {
      var k = l.indexOf('\t');
      return k < 0 ? { q: l.trim(), a: '' } : { q: l.slice(0, k).trim(), a: l.slice(k + 1).trim().replace(/\\n/g, '\n') };
    });
  }
  return text.split(/\n\s*\n/).map(function (b) {
    var ls = b.split('\n');
    return { q: ls[0].trim(), a: ls.slice(1).join('\n').trim() };
  }).filter(function (c) { return c.q; });
}
function nextNo(d) {
  var max = 0;
  d.cards.forEach(function (c) { var x = parseInt(c.n, 10); if (x > max) max = x; });
  return Math.max(max, d.cards.length);
}

/* ---------- beleške, fajlovi i folderi ---------- */
function openNote(id, from) {
  var x = noteById(id); if (!x) return;
  ui.noteId = id; ui.from = from === undefined ? (x.folderId || null) : from;
  ui.screen = isBuiltin(id) ? 'noteRead' : x.type === 'pdf' ? 'pdf' : x.type === 'docx' ? 'docx' : 'noteEdit';
  render();
}
function backFromNote() {
  var x = data.notes.find(function (n) { return n.id === ui.noteId; });
  // prazna tekstualna beleška se ne čuva
  if (x && x.type === 'text' && !x.title.trim() && !x.body.trim()) { data.notes = data.notes.filter(function (n) { return n !== x; }); save(); }
  if (ui.from && folderById(ui.from)) { ui.folderId = ui.from; ui.screen = 'folder'; }
  else { ui.screen = 'home'; data.tab = 'notes'; }
  render();
}
function deleteNote(id) {
  var idx = data.notes.findIndex(function (x) { return x.id === id; });
  if (idx < 0) return;
  var removed = data.notes.splice(idx, 1)[0];
  if (removed.fileId) scheduleFileDelete(removed.fileId);
  save();
  if (ui.from && folderById(ui.from)) { ui.folderId = ui.from; ui.screen = 'folder'; } else { ui.screen = 'home'; data.tab = 'notes'; }
  render(true);
  toast(t('Beleška „{name}“ je obrisana', { name: removed.title || t('Bez naslova') }), t('Vrati'), function () {
    if (removed.fileId) cancelFileDelete(removed.fileId);
    data.notes.splice(Math.min(idx, data.notes.length), 0, removed);
    save(); render(true);
  });
}
function askDeleteNote() {
  var x = noteById(ui.noteId); if (!x) return;
  if (x.type === 'text') { deleteNote(x.id); return; }
  modal({
    title: t('Obrisati dokument?'),
    text: t('Dokument „{name}“ biće obrisan sa ovog uređaja.', { name: x.title }),
    buttons: [{ label: t('Obriši dokument'), kind: 'danger', onClick: function () { deleteNote(x.id); } }, { label: t('Otkaži'), kind: 'cancel' }]
  });
}

function newFolder(then) {
  modal({
    title: t('Novi folder'), input: { value: '', placeholder: t('Naziv foldera') },
    buttons: [{ label: t('Napravi folder'), kind: 'primary', onClick: function (v) {
      v = (v || '').trim(); if (!v) return false;
      var f = { id: uid(), name: v.slice(0, 60) };
      data.folders.push(f); save();
      if (then) then(f); else render(true);
    } }, { label: t('Otkaži'), kind: 'cancel' }]
  });
}
function renameFolder() {
  var f = folderById(ui.folderId); if (!f) return;
  modal({
    title: t('Preimenuj folder'), input: { value: f.name, placeholder: t('Naziv foldera') },
    buttons: [{ label: t('Sačuvaj'), kind: 'primary', onClick: function (v) {
      v = (v || '').trim(); if (!v) return false;
      f.name = v.slice(0, 60); save(); render(true);
    } }, { label: t('Otkaži'), kind: 'cancel' }]
  });
}
function askDeleteFolder() {
  var f = folderById(ui.folderId); if (!f) return;
  var inside = notesIn(f.id);
  var buttons = inside.length ? [
    { label: t('Obriši folder i beleške ({n})', { n: inside.length }), kind: 'danger', onClick: function () { deleteFolder(f, true); } },
    { label: t('Obriši samo folder'), kind: 'plain', onClick: function () { deleteFolder(f, false); } },
    { label: t('Nemoj da brišeš'), kind: 'cancel' }
  ] : [
    { label: t('Obriši folder'), kind: 'danger', onClick: function () { deleteFolder(f, false); } },
    { label: t('Nemoj da brišeš'), kind: 'cancel' }
  ];
  modal({
    title: t('Obrisati folder?'),
    text: inside.length
      ? t('Folder „{name}“ ima {n} {w}. Možeš da obrišeš i njih, ili samo folder, pa će beleške preći u „Beleške van foldera“.', { name: f.name, n: inside.length, w: pw(inside.length, 'beleška') })
      : t('Folder „{name}“ je prazan.', { name: f.name }),
    buttons: buttons
  });
}
function deleteFolder(f, withNotes) {
  var fIdx = data.folders.indexOf(f);
  var inside = notesIn(f.id);
  var removedNotes = [];
  data.folders.splice(fIdx, 1);
  if (withNotes) {
    removedNotes = inside.map(function (n) { return { note: n, idx: data.notes.indexOf(n) }; });
    data.notes = data.notes.filter(function (n) { return inside.indexOf(n) < 0; });
    inside.forEach(function (n) { if (n.fileId) scheduleFileDelete(n.fileId); });
  } else {
    inside.forEach(function (n) { n.folderId = null; });
  }
  save();
  ui.screen = 'home'; data.tab = 'notes'; render();
  toast(t('Folder „{name}“ je obrisan', { name: f.name }), t('Vrati'), function () {
    data.folders.splice(Math.min(fIdx, data.folders.length), 0, f);
    if (withNotes) {
      removedNotes.sort(function (a, b) { return a.idx - b.idx; }).forEach(function (r) {
        if (r.note.fileId) cancelFileDelete(r.note.fileId);
        data.notes.splice(Math.min(r.idx, data.notes.length), 0, r.note);
      });
    } else {
      inside.forEach(function (n) { n.folderId = f.id; });
    }
    save(); render(true);
  });
}
function moveNote() {
  var x = data.notes.find(function (n) { return n.id === ui.noteId; }); if (!x) return;
  function moveTo(folderId) {
    x.folderId = folderId; ui.from = folderId; save();
    var f = folderById(folderId);
    toast(f ? t('Premešteno u „{name}“', { name: f.name }) : t('Premešteno u „Beleške van foldera“'));
    render(true);
  }
  var cur = x.folderId || null;
  var buttons = [{ label: t('Beleške van foldera') + (cur === null ? ' ✓' : ''), kind: cur === null ? 'current' : 'plain', onClick: function () { moveTo(null); } }]
    .concat(data.folders.map(function (f) {
      return { label: f.name + (cur === f.id ? ' ✓' : ''), kind: cur === f.id ? 'current' : 'plain', onClick: function () { moveTo(f.id); } };
    }))
    .concat([{ label: t('+ Novi folder'), kind: 'plain', onClick: function () { newFolder(function (f) { moveTo(f.id); }); } },
      { label: t('Otkaži'), kind: 'cancel' }]);
  modal({ title: t('Premesti u folder'), text: x.title || t('Bez naslova'), buttons: buttons });
}

function extOf(name) { var m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
function readFile(file, asText) {
  return new Promise(function (res, rej) {
    var r = new FileReader();
    r.onload = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
    if (asText) r.readAsText(file, 'utf-8'); else r.readAsArrayBuffer(file);
  });
}
function askPersist() { try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {} }

async function importFiles(files, folderId) {
  var ok = 0, failed = [];
  for (var i = 0; i < files.length; i++) {
    var file = files[i], ext = extOf(file.name), title = file.name.replace(/\.[^.]+$/, '');
    try {
      if (ext === 'txt' || (!ext && /^text\//.test(file.type))) {
        var text = String(await readFile(file, true) || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
        data.notes.push({ id: uid(), type: 'text', title: title, body: text, folderId: folderId, updated: Date.now() });
        ok++;
      } else if (ext === 'pdf' || ext === 'docx') {
        var buf = await readFile(file, false);
        var fileId = uid();
        await filePut(fileId, { name: file.name, type: file.type || (ext === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), buf: buf });
        data.notes.push({ id: uid(), type: ext, title: title, fileId: fileId, size: file.size, folderId: folderId, updated: Date.now(), pages: null, lastPage: 1 });
        askPersist();
        ok++;
      } else if (ext === 'doc') {
        failed.push(t('„{name}“: stari .doc format nije podržan, sačuvaj ga kao .docx', { name: file.name }));
      } else {
        failed.push(t('„{name}“: podržani su .txt, .pdf i .docx', { name: file.name }));
      }
    } catch (e) {
      failed.push(t('„{name}“: nema dovoljno prostora ili fajl nije mogao da se pročita', { name: file.name }));
    }
  }
  save(); render(true);
  if (failed.length) {
    modal({ title: ok ? t('Uvezeno: {n}', { n: ok }) : t('Fajl nije uvezen'), text: failed.join('\n'), buttons: [{ label: t('U redu'), kind: 'cancel' }] });
  } else if (ok) {
    toast(t('Uvezeno: {n} {w}', { n: ok, w: pw(ok, 'beleška') }));
  }
}

/* čuvanje fajla: na telefonu meni za deljenje (Sačuvaj u Fajlove), na računaru preuzimanje */
function downloadBlob(name, blob) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
function saveFile(name, blob) {
  var file = null;
  try { file = new File([blob], name, { type: blob.type }); } catch (e) {}
  var touch = window.matchMedia('(pointer: coarse)').matches;
  if (touch && file && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: name }).catch(function (err) { if (!err || err.name !== 'AbortError') downloadBlob(name, blob); });
    return;
  }
  downloadBlob(name, blob);
}
function safeName(s) { return (s || 'beleska').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 80) || 'beleska'; }

// trenutno otvoren dokument ostaje u memoriji da bi "Preuzmi" radilo odmah (iOS traži deljenje odmah posle dodira)
var openFile = { fileId: null, rec: null };
function downloadNote() {
  var x = noteById(ui.noteId); if (!x) return;
  if (!x.type || x.type === 'text' || isBuiltin(x.id)) {
    saveFile(safeName(x.title) + '.txt', new Blob([(x.title ? x.title + '\n\n' : '') + (x.body || '')], { type: 'text/plain;charset=utf-8' }));
    return;
  }
  if (openFile.fileId === x.fileId && openFile.rec) {
    saveFile(openFile.rec.name || safeName(x.title) + '.' + x.type, new Blob([openFile.rec.buf], { type: openFile.rec.type }));
    return;
  }
  fileGet(x.fileId).then(function (rec) {
    if (!rec) { toast(t('Fajl nije pronađen na ovom uređaju.')); return; }
    openFile = { fileId: x.fileId, rec: rec };
    modal({ title: t('Fajl je spreman'), text: rec.name, buttons: [
      { label: t('Sačuvaj'), kind: 'primary', onClick: function () { saveFile(rec.name, new Blob([rec.buf], { type: rec.type })); } },
      { label: t('Otkaži'), kind: 'cancel' }] });
  });
}
function getOpenFile(fileId) {
  if (openFile.fileId === fileId && openFile.rec) return Promise.resolve(openFile.rec);
  return fileGet(fileId).then(function (rec) { if (rec) openFile = { fileId: fileId, rec: rec }; return rec; });
}

/* ---------- DOCX: tekst iz Word dokumenta, u bojama izabrane teme ---------- */
var docxCache = {};
function cleanDocxHtml(html) {
  var tpl = document.createElement('template');
  tpl.innerHTML = html;
  var root = tpl.content;
  root.querySelectorAll('script, style, iframe, object, embed').forEach(function (el) { el.remove(); });
  root.querySelectorAll('*').forEach(function (el) {
    Array.prototype.slice.call(el.attributes).forEach(function (a) {
      var n = a.name.toLowerCase();
      if (n.indexOf('on') === 0 || n === 'style') el.removeAttribute(a.name);
      if ((n === 'href' || n === 'src') && !/^(https?:|mailto:|#|data:image\/)/i.test(a.value.trim())) el.removeAttribute(a.name);
    });
    if (el.tagName === 'A' && /^https?:/i.test(el.getAttribute('href') || '')) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener'); }
  });
  root.querySelectorAll('table').forEach(function (tb) {
    var w = document.createElement('div'); w.className = 'table-wrap';
    tb.parentNode.insertBefore(w, tb); w.appendChild(tb);
  });
  var div = document.createElement('div'); div.appendChild(root);
  return div.innerHTML;
}
async function mountDocx() {
  var x = noteById(ui.noteId), box = document.getElementById('docxBody');
  if (!x || !box) return;
  try {
    var html = docxCache[x.fileId];
    if (!html) {
      var parts = await Promise.all([loadScript('vendor/mammoth.browser.min.js'), getOpenFile(x.fileId)]);
      var rec = parts[1];
      if (!rec) throw new Error('missing');
      var result = await window.mammoth.convertToHtml({ arrayBuffer: rec.buf.slice(0) });
      html = cleanDocxHtml(result.value || '') || '<p class="empty-note">' + t('Dokument nema teksta.') + '</p>';
      docxCache[x.fileId] = html;
    }
    var now = document.getElementById('docxBody');
    if (now && ui.screen === 'docx' && ui.noteId === x.id) now.innerHTML = html;
  } catch (e) {
    var b = document.getElementById('docxBody');
    if (b) b.innerHTML = '<p class="empty-note">' + t('Dokument nije mogao da se otvori. Proveri da li je fajl ispravan .docx.') + '</p>';
  }
}

/* ---------- PDF: stranice se listaju kao u knjizi (StPageFlip) ---------- */
var pdfDoc = null;   // { fileId, doc }
var book = null;     // { pf, els, rendered, count, pageW, spread, noteId, wrapW, wrapH }
function destroyBook() {
  if (!book) return;
  try { book.pf.destroy(); } catch (e) {}
  book = null;
}
async function mountPdf() {
  var x = noteById(ui.noteId);
  var wrap = document.getElementById('bookWrap');
  if (!x || !wrap) return;
  try {
    await Promise.all([loadScript('vendor/pdf.min.js'), loadScript('vendor/page-flip.browser.js')]);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    if (!pdfDoc || pdfDoc.fileId !== x.fileId) {
      if (pdfDoc) { try { pdfDoc.doc.destroy(); } catch (e) {} pdfDoc = null; }
      var rec = await getOpenFile(x.fileId);
      if (!rec) throw new Error('missing');
      var doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(rec.buf.slice(0)) }).promise;
      pdfDoc = { fileId: x.fileId, doc: doc };
    }
    if (ui.screen !== 'pdf' || ui.noteId !== x.id) return;
    var first = await pdfDoc.doc.getPage(1);
    var vp = first.getViewport({ scale: 1 });
    if (x.pages !== pdfDoc.doc.numPages) { x.pages = pdfDoc.doc.numPages; save(); }
    buildBook(x, vp.width / vp.height);
  } catch (e) {
    var w = document.getElementById('bookWrap');
    if (w) w.innerHTML = '<p class="empty-note">' + t('PDF nije mogao da se otvori. Proveri da li je fajl ispravan.') + '</p>';
  }
}
function buildBook(x, ratio) {
  var wrap = document.getElementById('bookWrap');
  if (!wrap || !pdfDoc) return;
  var keepPage = book ? book.pf.getCurrentPageIndex() : Math.max(0, (x.lastPage || 1) - 1);
  destroyBook();
  var W = wrap.clientWidth, H = wrap.clientHeight;
  var count = pdfDoc.doc.numPages;
  var spread = W >= 700 && W > H * 1.2 && count > 1;   // dve strane jedna pored druge
  var pageW = Math.floor(Math.min(spread ? W / 2 : W, H * ratio));
  var pageH = Math.floor(pageW / ratio);
  var el = document.createElement('div');
  el.className = 'book';
  el.style.width = (spread ? pageW * 2 : pageW) + 'px';
  el.style.height = pageH + 'px';
  wrap.innerHTML = '';
  wrap.appendChild(el);
  var els = [];
  for (var i = 0; i < count; i++) {
    var p = document.createElement('div');
    p.className = 'pdf-page'; p.dataset.density = 'soft';
    p.innerHTML = '<span class="pdf-page-no">' + (i + 1) + '</span>';
    el.appendChild(p); els.push(p);
  }
  var start = Math.min(Math.max(keepPage, 0), count - 1);
  var pf = new window.St.PageFlip(el, {
    width: pageW, height: pageH, size: 'fixed', autoSize: false,
    usePortrait: true, showCover: false, startPage: start,
    drawShadow: true, maxShadowOpacity: 0.4,
    flippingTime: data.settings.reduceMotion ? 250 : 750,
    mobileScrollSupport: false, swipeDistance: 20, showPageCorners: true
  });
  pf.loadFromHTML(els);
  book = { pf: pf, els: els, rendered: {}, count: count, pageW: pageW, spread: spread, noteId: x.id, wrapW: W, wrapH: H, ratio: ratio };
  pf.on('flip', function (e) { onPdfPage(e.data); });
  onPdfPage(start);
}
function onPdfPage(idx) {
  var b = book; if (!b) return;
  var x = noteById(b.noteId);
  if (x && x.lastPage !== idx + 1) { x.lastPage = idx + 1; save(); }
  var label = (idx + 1) + (b.spread && idx + 2 <= b.count && idx % 2 === 0 ? '–' + (idx + 2) : '') + ' / ' + b.count;
  var c = document.getElementById('pdfCount'); if (c) c.textContent = label;
  var r = document.getElementById('pdfRange'); if (r) { r.max = b.count; r.value = idx + 1; }
  for (var i = idx - 2; i <= idx + 3; i++) renderPdfPage(i);
  Object.keys(b.rendered).forEach(function (k) {
    if (Math.abs(k - idx) > 8 && b.rendered[k] instanceof HTMLCanvasElement) {
      b.rendered[k].width = 0; b.rendered[k].remove(); delete b.rendered[k];
    }
  });
}
async function renderPdfPage(i) {
  var b = book;
  if (!b || !pdfDoc || i < 0 || i >= b.count || b.rendered[i]) return;
  b.rendered[i] = 'pending';
  try {
    var page = await pdfDoc.doc.getPage(i + 1);
    if (book !== b) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var vp1 = page.getViewport({ scale: 1 });
    var vp = page.getViewport({ scale: b.pageW / vp1.width * dpr });
    var canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    if (book !== b) return;
    b.els[i].appendChild(canvas);
    b.rendered[i] = canvas;
  } catch (e) { if (book === b) delete b.rendered[i]; }
}
function pdfGoTo(n) {
  if (!book) return;
  n = Math.min(Math.max(n, 1), book.count) - 1;
  book.pf.turnToPage(n);
  onPdfPage(n);
}
function pdfMenu() {
  var x = noteById(ui.noteId); if (!x) return;
  modal({
    title: x.title,
    buttons: [
      { label: data.settings.pdfDark ? t('Svetle stranice') : t('Tamne stranice'), kind: 'plain', onClick: function () {
        data.settings.pdfDark = !data.settings.pdfDark; save();
        var w = document.getElementById('bookWrap'); if (w) w.classList.toggle('dark-pages', data.settings.pdfDark);
      } },
      { label: t('Idi na stranu…'), kind: 'plain', onClick: function () {
        setTimeout(function () {
          modal({ title: t('Idi na stranu'), input: { value: String(x.lastPage || 1), placeholder: '1–' + (x.pages || 1) },
            buttons: [{ label: t('Idi'), kind: 'primary', onClick: function (v) { var n = parseInt(v, 10); if (!n) return false; pdfGoTo(n); } }, { label: t('Otkaži'), kind: 'cancel' }] });
        }, 0);
      } },
      { label: t('Premesti u folder'), kind: 'plain', onClick: function () { setTimeout(moveNote, 0); } },
      { label: t('Preuzmi PDF'), kind: 'plain', onClick: function () { downloadNote(); } },
      { label: t('Obriši dokument'), kind: 'danger', onClick: function () { setTimeout(askDeleteNote, 0); } },
      { label: t('Zatvori'), kind: 'cancel' }
    ]
  });
}
var bookResizeTimer = null;
window.addEventListener('resize', function () {
  if (ui.screen !== 'pdf' || !book) return;
  clearTimeout(bookResizeTimer);
  bookResizeTimer = setTimeout(function () {
    var wrap = document.getElementById('bookWrap'); if (!wrap || !book) return;
    if (Math.abs(wrap.clientWidth - book.wrapW) > 20 || Math.abs(wrap.clientHeight - book.wrapH) > 20) {
      var x = noteById(book.noteId); if (x) buildBook(x, book.ratio);
    }
  }, 250);
});

/* ---------- rezervna kopija ---------- */
function bufToB64(buf) {
  var bytes = new Uint8Array(buf), out = '', chunk = 0x8000;
  for (var i = 0; i < bytes.length; i += chunk) out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(out);
}
function b64ToBuf(s) {
  var bin = atob(s), bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
async function backupExport() {
  toast(t('Pripremam rezervnu kopiju…'));
  try {
    saveNow();
    var files = {};
    var withFiles = data.notes.filter(function (n) { return n.fileId; });
    for (var i = 0; i < withFiles.length; i++) {
      var rec = await fileGet(withFiles[i].fileId);
      if (rec) files[withFiles[i].fileId] = { name: rec.name, type: rec.type, b64: bufToB64(rec.buf) };
    }
    var json = JSON.stringify({ app: 'kartice', format: 1, version: APP_VERSION, created: Date.now(), data: data, files: files });
    var day = new Date().toISOString().slice(0, 10);
    var name = 'kartice-rezervna-kopija-' + day + '.json';
    var blob = new Blob([json], { type: 'application/json' });
    modal({ title: t('Rezervna kopija je spremna'), text: name + ' · ' + fmtSize(blob.size), buttons: [
      { label: t('Sačuvaj'), kind: 'primary', onClick: function () { saveFile(name, blob); } },
      { label: t('Otkaži'), kind: 'cancel' }] });
  } catch (e) {
    toast(t('Rezervna kopija nije uspela.'));
  }
}
async function backupImport(file) {
  var obj;
  try { obj = JSON.parse(await readFile(file, true)); } catch (e) { obj = null; }
  if (!obj || obj.app !== 'kartice' || !obj.data || !Array.isArray(obj.data.decks)) {
    modal({ title: t('Ovo nije rezervna kopija Kartica'), text: t('Izaberi .json fajl koji si napravio dugmetom „Napravi rezervnu kopiju“.'), buttons: [{ label: t('U redu'), kind: 'cancel' }] });
    return;
  }
  var nDecks = obj.data.decks.length, nNotes = (obj.data.notes || []).length;
  modal({
    title: t('Vratiti rezervnu kopiju?'),
    text: t('Kopija ima {d} {dw} i {n} {nw}. Sve trenutne kartice, beleške i fajlovi na ovom uređaju biće zamenjeni.', { d: nDecks, dw: pw(nDecks, 'špil'), n: nNotes, nw: pw(nNotes, 'beleška') }),
    buttons: [{ label: t('Vrati kopiju'), kind: 'danger', onClick: function () {
      (async function () {
        try {
          await fileClear();
          var ids = Object.keys(obj.files || {});
          for (var i = 0; i < ids.length; i++) {
            var f = obj.files[ids[i]];
            await filePut(ids[i], { name: f.name, type: f.type, buf: b64ToBuf(f.b64) });
          }
          localStorage.setItem(STORE_KEY, JSON.stringify(obj.data));
          location.reload();
        } catch (e) { toast(t('Vraćanje nije uspelo. Nema dovoljno prostora na uređaju.')); }
      })();
    } }, { label: t('Otkaži'), kind: 'cancel' }]
  });
}
function fillStorageInfo() {
  var el = document.getElementById('storageInfo'); if (!el) return;
  if (!navigator.storage || !navigator.storage.estimate) { el.textContent = ''; return; }
  navigator.storage.estimate().then(function (e) {
    var box = document.getElementById('storageInfo');
    if (box) box.textContent = t('Aplikacija zauzima {s} na ovom uređaju.', { s: fmtSize(e.usage || 0) });
  }).catch(function () {});
}

/* ---------- akcije (data-act na dugmadi) ---------- */
var acts = {
  home: function () { ui.screen = 'home'; ui.manage = false; render(); },
  settings: function () { ui.screen = 'settings'; render(); },
  open: function (id) { ui.deckId = id; ui.screen = 'deck'; ui.manage = false; render(); },
  newDeck: function () {
    var d = { id: uid(), name: t('Novi špil'), tag: '', cards: [], known: {} };
    data.decks.push(d); save();
    ui.deckId = d.id; ui.screen = 'edit'; render();
    var n = document.getElementById('deckName'); if (n) { n.focus(); n.select(); }
  },
  theme: function (v) { data.theme = v; save(); render(true); },
  order: function (v) { data.random = v === 'rnd'; save(); render(true); },
  startAll: function () { begin(deck().cards.map(function (c) { return c.id; })); },
  startUnknown: function () { begin(unknownIds(deck())); },
  reset: function () {
    modal({ title: t('Resetovati napredak?'), text: t('Sve kartice u ovom špilu biće označene kao nenaučene.'),
      buttons: [{ label: t('Resetuj napredak'), kind: 'danger', onClick: function () { deck().known = {}; save(); render(true); toast(t('Napredak je resetovan')); } },
        { label: t('Otkaži'), kind: 'cancel' }] });
  },
  edit: function () { ui.screen = 'edit'; render(); },
  toDeck: function () { ui.screen = 'deck'; ui.flipped = false; render(); },
  flip: flip,
  prev: function () { go(ui.i - 1); },
  yes: function () { mark(true); },
  no: function () { mark(false); },
  fs: function () {
    try {
      var p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  },
  addCard: function () {
    var d = deck(), c = { id: uid(), n: String(nextNo(d) + 1), q: '', a: '' };
    d.cards.push(c); save(); render(true);
    var el = document.getElementById('q-' + c.id);
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.focus({ preventScroll: true }); }
  },
  delCard: function (id) {
    var d = deck();
    d.cards = d.cards.filter(function (c) { return c.id !== id; });
    delete d.known[id]; save(); render(true); toast(t('Kartica je obrisana'));
  },
  manage: function () { ui.manage = !ui.manage; render(true); },
  tab: function (v) { data.tab = v; ui.manage = false; save(); render(true); },
  delDeck: function (id) { askDeleteDeck(id || ui.deckId); },
  import: function () {
    var ta = document.getElementById('importText');
    var list = parseImport(ta.value);
    if (!list.length) { toast(t('Nema kartica u tekstu. Proveri format.')); return; }
    var d = deck(), start = nextNo(d);
    list.forEach(function (c, k) { d.cards.push({ id: uid(), n: String(start + k + 1), q: c.q, a: c.a }); });
    save(); render(true);
    toast(t('Dodato: {n} {w}', { n: list.length, w: pw(list.length, 'kartica') }));
  },
  export: function () {
    var d = deck();
    var text = d.cards.map(function (c) { return c.q + (c.a ? '\n' + c.a.replace(/\n\s*\n/g, '\n') : ''); }).join('\n\n');
    var done = function () { toast(t('Kopirano: {n} {w}', { n: d.cards.length, w: pw(d.cards.length, 'kartica') })); };
    var fallback = function () {
      var det = document.querySelector('.import'); det.open = true;
      var ta = document.getElementById('importText'); ta.value = text; ta.focus(); ta.select();
      toast(t('Tekst je označen. Kopiraj ga sa Ctrl+C.'));
    };
    try { navigator.clipboard.writeText(text).then(done, fallback); } catch (e) { fallback(); }
  },

  // beleške i folderi
  openNote: function (id) { openNote(id); },
  openFolder: function (id) { ui.folderId = id; ui.screen = 'folder'; render(); },
  newFolder: function () { newFolder(); },
  renameFolder: renameFolder,
  delFolder: askDeleteFolder,
  toNotes: function () { ui.screen = 'home'; data.tab = 'notes'; render(); },
  backFromNote: backFromNote,
  newNote: function (folderId) {
    var x = { id: uid(), type: 'text', title: '', body: '', folderId: folderId || null, updated: Date.now() };
    data.notes.push(x); save();
    ui.noteId = x.id; ui.from = x.folderId; ui.screen = 'noteEdit'; render();
    var el = document.getElementById('noteTitle'); if (el) el.focus();
  },
  importFile: function (folderId) {
    var f = document.getElementById('noteFile'); if (!f) return;
    f.dataset.folder = folderId || '';
    f.click();
  },
  moveNote: moveNote,
  delNote: askDeleteNote,
  downloadNote: downloadNote,
  pdfPrev: function () { if (book) book.pf.flipPrev(); },
  pdfNext: function () { if (book) book.pf.flipNext(); },
  pdfMenu: pdfMenu,

  // podešavanja
  setFont: function (v) { data.settings.font = v; save(); render(true); },
  setSize: function (v) { data.settings.size = v; save(); render(true); },
  setLang: function (v) { data.settings.lang = v; setLang(v); save(); render(true); },
  toggleSetting: function (k) { data.settings[k] = !data.settings[k]; save(); render(true); },
  backupExport: backupExport,
  backupImport: function () { var f = document.getElementById('backupFile'); if (f) f.click(); }
};

/* ---------- događaji ---------- */
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-act]');
  if (!el || el.disabled || el.closest('.modal-back')) return;
  if (swipe.suppressClick) { swipe.suppressClick = false; return; }
  var f = acts[el.dataset.act];
  if (f) f(el.dataset.arg, el);
});

document.addEventListener('input', function (e) {
  var tg = e.target;
  if (tg.dataset.note) {
    var x = data.notes.find(function (n) { return n.id === ui.noteId; });
    if (x) {
      x[tg.dataset.note] = tg.value; x.updated = Date.now(); save();
      var s = document.getElementById('noteSaved'); if (s) s.textContent = t('Sačuvano automatski · {d}', { d: fmtDate(x.updated) });
    }
    if (tg.tagName === 'TEXTAREA') autosize(tg);
    return;
  }
  if (tg.id === 'noteSearch') { searchNotes(tg.value); return; }
  if (tg.id === 'pdfRange') {
    var c = document.getElementById('pdfCount'); if (c && book) c.textContent = tg.value + ' / ' + book.count;
    return;
  }
  var d = deck();
  if (!d) return;
  if (tg.dataset.field) {
    var card = cardById(d, tg.dataset.id);
    if (card) { card[tg.dataset.field] = tg.value; save(); }
    autosize(tg);
  } else if (tg.dataset.deck) {
    d[tg.dataset.deck] = tg.value; save();
  }
});
function searchNotes(q) {
  q = q.trim().toLowerCase();
  var main = document.getElementById('notesMain'), res = document.getElementById('noteResults');
  if (!main || !res) return;
  if (!q) { main.hidden = false; res.hidden = true; res.innerHTML = ''; return; }
  var all = BUILTIN_NOTES.concat(data.notes).filter(function (x) {
    var hay = ((x.title || '') + ' ' + (x.subject || '') + ' ' + (x.type === 'text' || !x.type ? x.body || '' : '')).toLowerCase();
    return hay.indexOf(q) >= 0;
  });
  main.hidden = true; res.hidden = false;
  res.innerHTML = '<span class="label">' + t('Rezultati') + '</span>' +
    (all.length ? noteList(all, { showFolder: true }) : '<p class="empty-note">' + t('Nijedna beleška ne sadrži taj tekst.') + '</p>');
}
document.addEventListener('change', function (e) {
  var tg = e.target;
  if (tg.id === 'noteFile' && tg.files.length) {
    var files = Array.prototype.slice.call(tg.files);
    var folderId = tg.dataset.folder || null;
    tg.value = '';
    importFiles(files, folderId);
  } else if (tg.id === 'backupFile' && tg.files.length) {
    var f = tg.files[0]; tg.value = '';
    backupImport(f);
  } else if (tg.id === 'pdfRange') {
    pdfGoTo(parseInt(tg.value, 10));
  }
});
function autosize(el) {
  if (CSS.supports && CSS.supports('field-sizing', 'content')) return;
  el.style.height = 'auto'; el.style.height = el.scrollHeight + 2 + 'px';
}

document.addEventListener('keydown', function (e) {
  var tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || document.querySelector('.modal-back')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (ui.screen === 'cards') {
    var onButton = e.target.closest && e.target.closest('button');
    if ((e.key === ' ' || e.key === 'Enter') && onButton && !onButton.classList.contains('card')) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (ui.flipped) mark(false); else go(ui.i - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (ui.flipped) mark(true); else flip(); }
    else if (e.key === '1' && ui.flipped) mark(false);
    else if (e.key === '2' && ui.flipped) mark(true);
    else if (e.key === 'Escape' && !document.fullscreenElement) acts.toDeck();
  } else if (ui.screen === 'pdf' && book) {
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); book.pf.flipPrev(); }
    else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); book.pf.flipNext(); }
    else if (e.key === 'Escape' && !document.fullscreenElement) backFromNote();
  } else if (ui.screen === 'done' && e.key === 'Escape') acts.toDeck();
});

/* prevlačenje kartice na telefonu */
var swipe = { x: 0, y: 0, dx: 0, active: false, el: null, suppressClick: false };
document.addEventListener('touchstart', function (e) {
  if (ui.screen !== 'cards') return;
  var area = e.target.closest('#cardArea'); if (!area) return;
  var tc = e.touches[0];
  swipe = { x: tc.clientX, y: tc.clientY, dx: 0, active: true, horiz: null, el: area.querySelector('.card'), suppressClick: false };
}, { passive: true });
document.addEventListener('touchmove', function (e) {
  if (!swipe.active || !swipe.el) return;
  var tc = e.touches[0], dx = tc.clientX - swipe.x, dy = tc.clientY - swipe.y;
  if (swipe.horiz === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) swipe.horiz = Math.abs(dx) > Math.abs(dy);
  if (!swipe.horiz) return;
  swipe.dx = dx;
  swipe.el.classList.add('dragging');
  swipe.el.style.animation = 'none';
  swipe.el.style.transform = 'translateX(' + dx * 0.7 + 'px) rotate(' + dx * 0.02 + 'deg)';
}, { passive: true });
document.addEventListener('touchend', function () {
  if (!swipe.active) return;
  swipe.active = false;
  var dx = swipe.dx, el = swipe.el;
  if (!swipe.horiz || !el) return;
  swipe.suppressClick = true;
  setTimeout(function () { swipe.suppressClick = false; }, 350);
  if (Math.abs(dx) > 70) {
    if (ui.flipped) mark(dx > 0);
    else if (dx < 0) flip();
    else if (ui.i > 0) go(ui.i - 1);
    else settle(el);
  } else settle(el);
});
function settle(el) {
  el.classList.remove('dragging'); el.classList.add('settle'); el.style.transform = '';
  setTimeout(function () { el.classList.remove('settle'); }, 260);
}

document.addEventListener('fullscreenchange', function () { ui.fs = !!document.fullscreenElement; render(true); });

// iOS aplikacija sa početnog ekrana: statusna traka nije providna (vidi index.html)
if (navigator.standalone === true) document.body.classList.add('ios-app');

/* Automatsko ažuriranje: iOS vraća aplikaciju iz pozadine bez ponovnog učitavanja,
   pa pri svakom povratku proveravamo version.json i osvežavamo ako postoji novija verzija.
   Ne osvežava se usred učenja, pisanja ili čitanja, nego kad korisnik pređe na drugi ekran. */
var pendingUpdate = false;
function checkUpdate() {
  if (!navigator.onLine) return;
  fetch('version.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    if (!j || !(j.v > APP_VERSION)) return;
    try { if (sessionStorage.getItem('kartice.reloadedFor') === String(j.v)) return; sessionStorage.setItem('kartice.reloadedFor', String(j.v)); } catch (e) {}
    pendingUpdate = true;
    applyUpdate();
  }).catch(function () {});
}
function applyUpdate() {
  if (!pendingUpdate) return;
  if (/^(cards|noteEdit|edit|pdf|docx)$/.test(ui.screen) || document.querySelector('.modal-back')) return;
  saveNow();
  location.reload();
}
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') checkUpdate(); });
window.addEventListener('pageshow', checkUpdate);
setTimeout(checkUpdate, 1500);

// privremeni podaci dijagnostike iz verzije 8 više nisu potrebni
try { localStorage.removeItem('kartice.layout'); } catch (e) {}

render();
