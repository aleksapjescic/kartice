/* Kartice — admin panel
   Vidi ga samo administrator (profiles.role = 'admin', vidi supabase/schema.sql). Ovde se uključuje i isključuje
   AI preko ključa aplikacije, menja dnevni limit i model, i upravlja korisnicima (limit, blokada, admin prava).
   Sve izmene idu preko funkcija u bazi koje same proveravaju da je pozivalac admin; aplikacija samo prikazuje. */

var adm = { users: null, cfg: null, err: '', loading: false, q: '' };

async function adminLoad() {
  if (adm.loading) return;
  adm.loading = true; adm.err = '';
  try {
    var c = await syncClient();
    var r1 = await c.rpc('admin_users'); if (r1.error) throw r1.error;
    var r2 = await c.from('app_config').select('*').eq('id', 1).single(); if (r2.error) throw r2.error;
    adm.users = r1.data || []; adm.cfg = r2.data;
  } catch (e) { adm.err = (e && e.message) || String(e); }
  adm.loading = false;
  if (/^admin(User)?$/.test(ui.screen)) render(true);
}
function adminOpen() { ui.screen = 'admin'; adm.users = null; adm.err = ''; render(); adminLoad(); }

async function adminCall(fn, args, done) {
  try {
    var c = await syncClient(), r = await c.rpc(fn, args);
    if (r.error) throw r.error;
    toast(done || t('Sačuvano'));
  } catch (e) { toast(t('Nije sačuvano: {m}', { m: (e && e.message) || '' })); }
  await adminLoad();
  syncLoadProfile();
}
function adminConfig(patch, done) { return adminCall('admin_set_config', { patch: patch }, done); }
function adminPatch(uid, patch, done) { return adminCall('admin_set_user', { uid: uid, patch: patch }, done); }

function adminUserRow(u) {
  var lim = adm.cfg ? adm.cfg.default_daily_limit : 0;
  var today = u.role === 'admin' ? t('danas {c} poziva', { c: u.today_calls })
    : t('danas {c} / {l}', { c: u.today_calls, l: u.daily_limit == null ? lim : u.daily_limit });
  var badges = (u.role === 'admin' ? '<span class="badge">' + t('Admin') + '</span>' : '') +
    (u.blocked ? '<span class="badge pdf">' + t('Blokiran') + '</span>' : '') +
    (u.daily_limit != null && u.role !== 'admin' ? '<span class="badge docx">' + t('Svoj limit') + '</span>' : '');
  var study = t('7 dana: {t} u aplikaciji · {a} odgovora · {d} dana (30 dana)', { t: fmtDuration(u.week_app_ms), a: u.week_answers || 0, d: u.open_days || 0 });
  return '<button class="note-item" data-act="adminUser" data-arg="' + esc(u.user_id) + '">' +
    '<span class="note-title">' + esc(u.email || u.name || u.user_id) + '</span>' +
    '<span class="note-preview num">' + esc(study) + '</span>' +
    '<span class="note-meta">' + badges + '<span>' + (u.last_seen ? t('aktivan {d}', { d: fmtDate(new Date(u.last_seen).getTime()) }) : t('još nije bio aktivan')) + '</span>' +
      '<span>· AI ' + esc(today) + '</span></span>' +
    '</button>';
}
// trajanje: ispod minuta u sekundama (ranije je 26 s prikazivano kao "0 min")
function fmtDuration(ms) {
  ms = +ms || 0;
  if (ms < 60000) return Math.round(ms / 1000) + ' s';
  var m = Math.round(ms / 60000);
  return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min';
}
// stubići za 14 dana; val(r) je vrednost dana, label(r) tekst u opisu
function miniChart(recent, val, label, aria) {
  var max = Math.max.apply(null, recent.map(val).concat([1]));
  return '<div class="mini-chart" role="img" aria-label="' + esc(aria) + '">' + recent.map(function (r) {
    var v = val(r), h = Math.round(v / max * 100);
    return '<span title="' + esc(fmtDate(new Date(r.day).getTime()) + ': ' + label(r)) + '"><i style="height:' + Math.max(h, v ? 4 : 0) + '%"></i></span>';
  }).join('') + '</div>';
}

/* ---------- detalji jednog korisnika: učenje i korišćenje (samo brojevi, bez sadržaja) ---------- */
function adminOpenUser(id) {
  adm.uid = id; adm.stats = null; adm.statsErr = '';
  ui.screen = 'adminUser'; render();
  syncClient().then(function (c) { return c.rpc('admin_user_stats', { uid: id }); }).then(function (r) {
    if (r.error) throw r.error;
    if (adm.uid === id) adm.stats = r.data;
  }).catch(function (e) { adm.statsErr = (e && e.message) || String(e); })
    .then(function () { if (ui.screen === 'adminUser') render(true); });
}
function statRow(label, value) {
  return '<div class="row-between"><span class="small-note">' + label + '</span><b class="num">' + value + '</b></div>';
}
function viewAdminUser() {
  var u = (adm.users || []).find(function (x) { return x.user_id === adm.uid; });
  var head = '<div class="topbar">' + backBtn('toAdmin', t('Admin panel')) +
    (u ? '<button class="link" data-act="adminUserActions" data-arg="' + esc(u.user_id) + '">' + t('Limit i prava') + '</button>' : '') + '</div>' +
    '<div class="head" style="padding-top:0"><span class="eyebrow">' + t('Korisnik') + '</span><h1 class="read-title">' + esc(u ? (u.email || u.name) : '') + '</h1>' +
    (u ? '<span class="sub num">' + t('Registrovan: {d}', { d: fmtDate(new Date(u.created).getTime()) }) + '</span>' : '') + '</div>';
  var s = adm.stats, body;
  if (!syncIsAdmin() || !u) body = '<p class="empty-note">' + t('Ovaj ekran je samo za administratore.') + '</p>';
  else if (adm.statsErr) body = '<p class="empty-note">' + t('Podaci nisu učitani: {m}', { m: esc(adm.statsErr) }) + '</p>';
  else if (!s) body = '<p class="empty-note">' + t('Učitavam…') + '</p>';
  else {
    var st = s.study || {}, c = s.content || {}, o = s.opens || {}, ai = s.ai || {};
    var acc = st.rv ? Math.round(st.ok / st.rv * 100) + '%' : '–';
    var recent = s.recent || [];
    var chart = miniChart(recent, function (r) { return +r.a || 0; }, function (r) { return String(r.a || 0); }, t('Odgovori po danima, poslednjih 14 dana'));
    var appChart = miniChart(recent, function (r) { return +r.app || 0; }, function (r) { return fmtDuration(r.app); }, t('Vreme u aplikaciji po danima, poslednjih 14 dana'));
    var me = sync.user && sync.user.id === u.user_id;
    body =
      (me ? '' : '<div class="section"><button class="btn primary" data-act="workAs" data-arg="' + esc(u.user_id) + '">' + t('Otvori njegov materijal') + '</button>' +
        '<p class="small-note">' + t('Vidiš i menjaš njegove špilove, kvizove i beleške, i praviš mu nove (i sa AI-jem). Sve izmene idu pravo na njegov nalog; tvoj materijal ostaje netaknut.') + '</p></div>') +
      '<div class="section"><h2>' + t('Učenje') + '</h2><div class="panel">' +
        statRow(t('Odgovora ukupno'), st.a || 0) +
        statRow(t('Novih kartica naučeno'), st.n || 0) +
        statRow(t('Tačnost u ponavljanju'), acc) +
        statRow(t('Vreme odgovaranja na kartice'), fmtDuration(st.ms)) +
        statRow(t('Dana sa učenjem'), st.days || 0) +
        statRow(t('Poslednje učenje'), st.last ? fmtDate(new Date(st.last).getTime()) : '–') +
        statRow(t('Kartica u ponavljanju'), s.learned || 0) +
      '</div><span class="label">' + t('Odgovori po danima, poslednjih 14 dana') + '</span>' + chart + '</div>' +
      '<div class="section"><h2>' + t('Korišćenje aplikacije') + '</h2><div class="panel">' +
        statRow(t('Vreme u aplikaciji (7 dana)'), fmtDuration(o.ms7)) +
        statRow(t('Vreme u aplikaciji ukupno'), fmtDuration(o.ms)) +
        statRow(t('Otvaranja ukupno'), o.total || 0) +
        statRow(t('Dana u aplikaciji (30 dana)'), o.days30 || 0) +
        statRow(t('Poslednje otvaranje'), o.last ? fmtDate(new Date(o.last).getTime()) : '–') +
        statRow(t('AI poziva ukupno'), ai.calls || 0) +
        statRow(t('AI tokena ukupno'), fmtTokens(ai.tokens)) +
      '</div><span class="label">' + t('Vreme u aplikaciji po danima, poslednjih 14 dana') + '</span>' + appChart +
      '<p class="small-note">' + t('Vreme u aplikaciji se računa dok je otvorena i korisnik nešto radi (uči, čita beleške, pravi kartice). Meri se od verzije 27; za ranije dane postoji samo vreme odgovaranja na kartice.') + '</p></div>' +
      '<div class="section"><h2>' + t('Sadržaj') + '</h2><div class="panel">' +
        statRow(t('Špilova'), c.deck || 0) + statRow(t('Kartica'), c.card || 0) +
        statRow(t('Kvizova'), c.quiz || 0) + statRow(t('Pitanja u kvizovima'), c.qq || 0) +
        statRow(t('Beleški'), c.note || 0) +
      '</div><p class="small-note">' + t('Učenje se računa iz podataka koje je aplikacija sinhronizovala.') + '</p></div>';
  }
  return '<div class="screen settings admin">' + head + body + '</div>';
}
function fmtTokens(n) {
  n = +n || 0;
  return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
}
function adminRows(q) {
  q = (q || '').trim().toLowerCase();
  var list = (adm.users || []).filter(function (u) { return !q || ((u.email || '') + ' ' + (u.name || '')).toLowerCase().indexOf(q) >= 0; });
  return list.length ? '<div class="note-list">' + list.map(adminUserRow).join('') + '</div>'
    : '<p class="empty-note">' + t('Nema korisnika za tu pretragu.') + '</p>';
}
function adminFilter(q) { adm.q = q; var el = document.getElementById('adminList'); if (el) el.innerHTML = adminRows(q); }

function viewAdmin() {
  var head = '<div class="topbar">' + backBtn('settings', t('Podešavanja')) +
    '<button class="link" data-act="adminReload">' + t('Osveži') + '</button></div>' +
    '<div class="head" style="padding-top:0"><span class="eyebrow">' + t('Administrator') + '</span><h1>' + t('Admin panel') + '</h1></div>';
  var body;
  if (!syncIsAdmin()) body = '<p class="empty-note">' + t('Ovaj ekran je samo za administratore.') + '</p>';
  else if (adm.err) body = '<p class="empty-note">' + t('Podaci nisu učitani: {m}', { m: esc(adm.err) }) + '</p>';
  else if (!adm.users || !adm.cfg) body = '<p class="empty-note">' + t('Učitavam…') + '</p>';
  else {
    var cfg = adm.cfg, us = adm.users;
    var todayCalls = us.reduce(function (s, u) { return s + (u.today_calls || 0); }, 0);
    var todayTok = us.reduce(function (s, u) { return s + (+u.today_tokens || 0); }, 0);
    var monthCalls = us.reduce(function (s, u) { return s + (u.month_calls || 0); }, 0);
    body =
      '<div class="section"><h2>' + t('Tvoj Gemini ključ') + '</h2>' +
        '<button class="toggle-row" role="switch" aria-checked="' + !!cfg.shared_key_on + '" data-act="adminToggleShared"><span>' + t('Besplatan AI za korisnike') +
          '<small>' + t('Kad je isključeno, AI radi samo onima koji upišu svoj ključ.') + '</small></span><span class="switch" aria-hidden="true"></span></button>' +
        '<button class="toggle-row" data-act="adminDefLimit"><span>' + t('Dnevni limit po korisniku') +
          '<small>' + t('Broj AI poziva dnevno. Administratori nemaju limit, a pojedinačnim korisnicima možeš da zadaš drugačiji.') + '</small></span><b class="num">' + cfg.default_daily_limit + '</b></button>' +
        '<button class="toggle-row" data-act="adminModel"><span>' + t('Model') +
          '<small>' + t('Gemini model koji koriste svi koji nemaju svoj ključ.') + '</small></span><b>' + esc(cfg.model) + '</b></button>' +
        '<p class="small-note num">' + t('Danas ukupno: {c} poziva, {k} tokena. Ovog meseca: {m} poziva.', { c: todayCalls, k: fmtTokens(todayTok), m: monthCalls }) + '</p>' +
      '</div>' +
      '<div class="section"><h2>' + t('Korisnici ({n})', { n: us.length }) + '</h2>' +
        (us.length > 5 ? '<input class="input search" id="adminSearch" type="search" value="' + esc(adm.q) + '" placeholder="' + esc(t('Pretraži po e-mail adresi')) + '" aria-label="' + esc(t('Pretraži korisnike')) + '" autocomplete="off">' : '') +
        '<div id="adminList">' + adminRows(adm.q) + '</div>' +
      '</div>';
  }
  return '<div class="screen settings admin">' + head + body + '</div>';
}

function adminDefLimit() {
  var cur = adm.cfg ? adm.cfg.default_daily_limit : 20;
  modal({ title: t('Dnevni limit po korisniku'), text: t('Koliko AI poziva dnevno ima korisnik bez svog limita. 0 znači da niko osim administratora ne može da koristi tvoj ključ.'),
    input: { value: String(cur), placeholder: '20' },
    buttons: [{ label: t('Sačuvaj'), kind: 'primary', onClick: function (v) {
      v = (v || '').trim(); if (!/^\d{1,5}$/.test(v)) { toast(t('Upiši ceo broj.')); return false; }
      adminConfig({ default_daily_limit: +v });
    } }, { label: t('Otkaži'), kind: 'cancel' }] });
}
function adminModel() {
  modal({ title: t('Gemini model'), text: t('Tačan naziv modela iz AI Studija, na primer gemini-3.8-flash. Ako model ne postoji, korisnici dobijaju poruku da AI nije podešen.'),
    input: { value: adm.cfg ? adm.cfg.model : '', placeholder: 'gemini-3.8-flash' },
    buttons: [{ label: t('Sačuvaj'), kind: 'primary', onClick: function (v) {
      v = (v || '').trim(); if (!/^[a-z0-9][a-z0-9.\-]{2,80}$/i.test(v)) { toast(t('Naziv modela nije ispravan.')); return false; }
      adminConfig({ model: v });
    } }, { label: t('Otkaži'), kind: 'cancel' }] });
}
function adminUser(id) {
  var u = (adm.users || []).find(function (x) { return x.user_id === id; }); if (!u) return;
  var me = sync.user && sync.user.id === u.user_id, def = adm.cfg ? adm.cfg.default_daily_limit : 0;
  var info = t('Registrovan: {d} · Danas {c} poziva, ovog meseca {m} poziva i {k} tokena.', {
    d: fmtDate(new Date(u.created).getTime()), c: u.today_calls, m: u.month_calls, k: fmtTokens(u.month_tokens) });
  var buttons = [];
  if (u.role !== 'admin') {
    buttons.push({ label: t('Sačuvaj limit'), kind: 'primary', onClick: function (v) {
      v = (v || '').trim(); if (v !== '' && !/^\d{1,5}$/.test(v)) { toast(t('Upiši ceo broj ili ostavi prazno.')); return false; }
      adminPatch(u.user_id, { daily_limit: v === '' ? null : +v });
    } });
  }
  if (!me) {
    buttons.push(u.blocked
      ? { label: t('Odblokiraj'), kind: 'plain', onClick: function () { adminPatch(u.user_id, { blocked: false }, t('Korisnik je odblokiran')); } }
      : { label: t('Blokiraj za AI'), kind: 'danger', onClick: function () { adminPatch(u.user_id, { blocked: true }, t('Korisnik je blokiran')); } });
  }
  buttons.push(u.role === 'admin'
    ? { label: me ? t('Oduzmi sebi admin prava') : t('Oduzmi admin prava'), kind: 'danger', onClick: function () { setTimeout(function () { adminConfirmRole(u, 'user'); }, 0); } }
    : { label: t('Daj admin prava'), kind: 'plain', onClick: function () { setTimeout(function () { adminConfirmRole(u, 'admin'); }, 0); } });
  buttons.push({ label: t('Zatvori'), kind: 'cancel' });
  modal({ title: u.email || u.name || t('Korisnik'), text: info,
    input: u.role === 'admin' ? undefined : { value: u.daily_limit == null ? '' : String(u.daily_limit), placeholder: t('Limit: prazno = podrazumevani ({n})', { n: def }) },
    buttons: buttons });
}
function adminConfirmRole(u, role) {
  var give = role === 'admin';
  modal({ title: give ? t('Dati admin prava?') : t('Oduzeti admin prava?'),
    text: give ? t('{e} će moći da vidi sve korisnike, menja limite i gasi tvoj ključ.', { e: u.email || '' })
      : t('{e} više neće videti admin panel.', { e: u.email || '' }),
    buttons: [{ label: give ? t('Daj admin prava') : t('Oduzmi admin prava'), kind: give ? 'primary' : 'danger', onClick: function () { adminPatch(u.user_id, { role: role }); } },
      { label: t('Otkaži'), kind: 'cancel' }] });
}
