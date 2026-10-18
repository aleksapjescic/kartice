/* Kartice — statistika i motivacija
   Dnevni zbirovi su u data.days[uređaj][dan] = { a, n, rv, ok, ms }:
     a  svi odgovori (i slobodno učenje i kvizovi),   n  nove stavke naučene tog dana,
     rv odgovori na stavke u ponavljanju,              ok od njih tačni (Teško, Dobro, Lako),   ms vreme.
   Svaki uređaj piše samo svoje zbirove, pa se pri sinhronizaciji ništa ne gazi; prikazuje se zbir svih uređaja.
   Pojedinačni odgovori idu i u istoriju u IndexedDB (store.js logAdd), samo na ovom uređaju. */

var DEVICE_ID = (function () {
  try {
    var id = localStorage.getItem('kartice.device');
    if (!id) { id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); localStorage.setItem('kartice.device', id); }
    return id;
  } catch (e) { return 'local'; }
})();

function myDay(day, create) {
  var dev = data.days[DEVICE_ID];
  if (!dev) { if (!create) return null; dev = data.days[DEVICE_ID] = {}; }
  if (!dev[day] && create) dev[day] = { a: 0, n: 0, rv: 0, ok: 0, ms: 0 };
  return dev[day] || null;
}
/* odgovor: e = { key, g (0 u slobodnom učenju, inače ocena 1–4), st (stanje pre odgovora), ms, srs (da li je raspored) }
   vraća podatke za "Poništi" */
function statRecord(e, now) {
  now = now || Date.now();
  var day = dayKey(now), r = myDay(day, true), ms = Math.max(0, Math.min(e.ms || 0, 120000));
  var delta = { a: 1, n: 0, rv: 0, ok: 0, ms: ms };
  if (e.srs) {
    if (e.st === ST.fresh) delta.n = 1;
    else if (e.st === ST.review) { delta.rv = 1; if (e.g >= RATING.hard) delta.ok = 1; }
  }
  Object.keys(delta).forEach(function (k) { r[k] += delta[k]; });
  var id = 'l' + now.toString(36) + Math.random().toString(36).slice(2, 6);
  logAdd({ id: id, t: now, k: e.key, g: e.g, ms: ms, st: e.st }).catch(function () {});
  var before = dayTotals(day).a - 1;
  if (before < (data.settings.goal || 0) && before + 1 >= data.settings.goal) setTimeout(goalReached, 400);
  return { day: day, delta: delta, logId: id };
}
function statUndo(u) {
  if (!u) return;
  var r = myDay(u.day, false);
  if (r) Object.keys(u.delta).forEach(function (k) { r[k] = Math.max(0, r[k] - u.delta[k]); });
  logDel(u.logId).catch(function () {});
}
// zbir svih uređaja za jedan dan
function dayTotals(day) {
  var out = { a: 0, n: 0, rv: 0, ok: 0, ms: 0 };
  Object.keys(data.days || {}).forEach(function (dev) {
    var r = data.days[dev][day];
    if (r) Object.keys(out).forEach(function (k) { out[k] += r[k] || 0; });
  });
  return out;
}
// svi dani sa bar jednim odgovorom: { 'YYYY-MM-DD': zbir }
function allDays() {
  var out = {};
  Object.keys(data.days || {}).forEach(function (dev) {
    Object.keys(data.days[dev]).forEach(function (day) {
      var r = data.days[dev][day], o = out[day] || (out[day] = { a: 0, n: 0, rv: 0, ok: 0, ms: 0 });
      Object.keys(o).forEach(function (k) { o[k] += r[k] || 0; });
    });
  });
  return out;
}
function prevDayKey(day) {
  var p = day.split('-'), d = new Date(+p[0], +p[1] - 1, +p[2] - 1, 12);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
// dani zaredom sa bar jednim odgovorom; današnji dan bez odgovora još ne prekida niz
function streak(now) {
  var days = allDays(), today = dayKey(now), d = today, cur = 0;
  if (!days[d] || !days[d].a) d = prevDayKey(d);
  while (days[d] && days[d].a) { cur++; d = prevDayKey(d); }
  var keys = Object.keys(days).filter(function (k) { return days[k].a; }).sort(), best = 0, run = 0, last = null;
  keys.forEach(function (k) { run = last && prevDayKey(k) === last ? run + 1 : 1; last = k; if (run > best) best = run; });
  return { cur: cur, best: Math.max(best, cur), today: !!(days[today] && days[today].a) };
}
function goalReached() {
  toast(t('Dnevni cilj je ispunjen: {n} odgovora. Bravo!', { n: data.settings.goal }));
}

/* ---------- značke ---------- */
var BADGES = [
  { id: 's7', icon: 'flame', label: '7 dana zaredom', test: function (x) { return x.best >= 7; } },
  { id: 's30', icon: 'flame', label: '30 dana zaredom', test: function (x) { return x.best >= 30; } },
  { id: 's100', icon: 'flame', label: '100 dana zaredom', test: function (x) { return x.best >= 100; } },
  { id: 'l100', icon: 'check', label: '100 naučenih kartica', test: function (x) { return x.learned >= 100; } },
  { id: 'l1000', icon: 'check', label: '1000 naučenih kartica', test: function (x) { return x.learned >= 1000; } },
  { id: 'a1000', icon: 'spark', label: '1000 odgovora', test: function (x) { return x.answers >= 1000; } }
];
function badgeFacts(now) {
  var st = streak(now), sc = stateCounts(allDeckKeys().concat(allQuizKeys())), days = allDays(), answers = 0;
  Object.keys(days).forEach(function (k) { answers += days[k].a; });
  return { best: st.best, learned: sc.young + sc.mature, answers: answers };
}
// nove značke posle odgovora: obaveštenje jednom
function checkBadges() {
  data.badges = data.badges || {};
  var f = badgeFacts(Date.now()), fresh = BADGES.filter(function (b) { return !data.badges[b.id] && b.test(f); });
  fresh.forEach(function (b) { data.badges[b.id] = Date.now(); });
  if (fresh.length) setTimeout(function () { toast(t('Nova značka: {b}', { b: t(fresh[0].label) })); }, 600);
}

/* ---------- početna: Danas ---------- */
function goalRing(done, goal) {
  var r = 17, c = 2 * Math.PI * r, p = goal ? Math.min(1, done / goal) : 0;
  return '<svg class="ring" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">' +
    '<circle cx="22" cy="22" r="' + r + '" fill="none" stroke="var(--line)" stroke-width="5"/>' +
    '<circle cx="22" cy="22" r="' + r + '" fill="none" stroke="var(--good)" stroke-width="5" stroke-linecap="round" ' +
      'stroke-dasharray="' + (c * p).toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 22 22)"/>' +
    '<text x="22" y="26.5" text-anchor="middle" font-size="12" font-weight="600" fill="var(--ink)">' + (p >= 1 ? '✓' : Math.round(p * 100) + '%') + '</text></svg>';
}
function todayPanel() {
  var now = Date.now(), dc = todayCounts(allDeckKeys(), now), qc = todayCounts(allQuizKeys(), now);
  var tot = dayTotals(dayKey(now)), goal = data.settings.goal || 0, st = streak(now);
  var line = dc.total ? dueText(dc) : t('Sve kartice su ponovljene za danas.');
  var goalLine = goal ? t('Cilj: {a} od {g} odgovora', { a: tot.a, g: goal }) : t('{a} odgovora danas', { a: tot.a });
  return '<div class="today panel">' +
    '<div class="today-top">' + goalRing(tot.a, goal) +
      '<div class="today-text"><b>' + t('Danas') + '</b><span>' + esc(line) + '</span><small>' + esc(goalLine) + '</small></div>' +
      (st.cur ? '<span class="streak' + (st.today ? '' : ' cold') + '" title="' + esc(t('Dani zaredom')) + '">' + ICON.flame + '<b class="num">' + st.cur + '</b></span>' : '') +
    '</div>' +
    (dc.total ? '<button class="btn primary" data-act="studyToday">' + t('Uči danas ({n})', { n: dc.total }) + '</button>' : '') +
    (qc.total ? '<button class="link" data-act="tab" data-arg="quizzes">' + t('Kvizovi: {n} za ponavljanje', { n: qc.total }) + '</button>' : '') +
    '</div>';
}

/* ---------- ekran Statistika ----------
   Grafikoni su sopstveni SVG u bojama teme: jednobojni stubići (--accent), kalendar u nijansama --good.
   Boje tema nisu dovoljno različite da bi dve serije razlikovale bojom, pa se razlaganje (nove,
   tačnost, vreme) vidi u oblačiću (pokazivač ili dodir) i u tabeli ispod grafikona. */
function dateAt(daysAgo) { var n = new Date(Date.now() - DAY_START_H * 36e5); return new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysAgo, 12); }
function shortDate(d) {
  try { return d.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' }); } catch (e) { return d.getDate() + '.' + (d.getMonth() + 1) + '.'; }
}
function fmtDuration(ms) {
  var m = Math.round(ms / 60000);
  if (m < 60) return t('{m} min', { m: m });
  return t('{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 });
}
function dayTip(d, r) {
  var s = shortDate(d) + ': ' + r.a + ' ' + pw(r.a, 'odgovor');
  if (r.n) s += ' · ' + t('nove {n}', { n: r.n });
  if (r.rv) s += ' · ' + t('tačno {p}%', { p: Math.round(r.ok / r.rv * 100) });
  return s;
}
// stubići: vals [{ v, tip, label }]; opts.ref je referentna linija (dnevni cilj)
function barsSvg(vals, opts) {
  opts = opts || {};
  var W = 600, H = 160, padB = 1, padT = 6, n = vals.length, gap = 2;
  var max = Math.max(1, opts.ref || 0, Math.max.apply(null, vals.map(function (x) { return x.v; })));
  var bw = (W - gap * (n - 1)) / n, ih = H - padB - padT, base = H - padB;
  var out = '<svg class="bars" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(opts.label || '') + '">';
  out += '<line x1="0" x2="' + W + '" y1="' + base + '" y2="' + base + '" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke"/>';
  if (opts.ref) {
    var ry = (base - opts.ref / max * ih).toFixed(1);
    out += '<line x1="0" x2="' + W + '" y1="' + ry + '" y2="' + ry + '" stroke="var(--strong)" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>';
  }
  vals.forEach(function (x, i) {
    var h = x.v / max * ih, xx = i * (bw + gap), y = base - h, r = Math.min(4, bw / 2, h);
    // cela kolona prima pokazivač (meta veća od samog stubića)
    out += '<rect x="' + xx.toFixed(1) + '" y="0" width="' + bw.toFixed(1) + '" height="' + H + '" fill="transparent" data-tip="' + esc(x.tip) + '"/>';
    if (h > 0) out += '<path pointer-events="none" fill="var(--accent)" d="M' + xx.toFixed(1) + ',' + base + 'V' + (y + r).toFixed(1) +
      'Q' + xx.toFixed(1) + ',' + y.toFixed(1) + ' ' + (xx + r).toFixed(1) + ',' + y.toFixed(1) + 'H' + (xx + bw - r).toFixed(1) +
      'Q' + (xx + bw).toFixed(1) + ',' + y.toFixed(1) + ' ' + (xx + bw).toFixed(1) + ',' + (y + r).toFixed(1) + 'V' + base + 'Z"/>';
  });
  out += '</svg>';
  // natpisi su HTML, jer je SVG rastegnut po širini ekrana
  var labels = '<div class="bars-x"><span>' + esc(vals[0].label) + '</span><span>' + esc(vals[Math.floor((n - 1) / 2)].label) + '</span><span>' + esc(vals[n - 1].label) + '</span></div>';
  var top = '<div class="bars-y"><span class="num">' + t('najviše {n}', { n: max }) + '</span>' + (opts.ref ? '<span class="ref-label">- - ' + esc(opts.refLabel || '') + ' ' + opts.ref + '</span>' : '') + '</div>';
  return '<div class="chart">' + top + out + labels + '</div>';
}
function tableOf(rows, head) {
  if (!rows.length) return '';
  return '<details class="table-view"><summary>' + t('Prikaži kao tabelu') + '</summary><div class="table-wrap"><table><thead><tr>' +
    head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
    rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') +
    '</tbody></table></div></details>';
}
// kalendar aktivnosti: 53 nedelje, kolona = nedelja od ponedeljka, nijansa po delu dnevnog cilja
function heatmapSvg(days) {
  var weeks = 53, cell = 11, gap = 2, top = 16, left = 24;
  var today = dateAt(0), dow = (today.getDay() + 6) % 7;          // 0 = ponedeljak
  var start = dateAt(dow + (weeks - 1) * 7);
  var goal = data.settings.goal || 0, max = 0;
  Object.keys(days).forEach(function (k) { if (days[k].a > max) max = days[k].a; });
  var ref = goal || max || 1;
  var W = left + weeks * (cell + gap), H = top + 7 * (cell + gap);
  var out = '<svg class="heat" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(t('Kalendar učenja')) + '">';
  ['Pon', 'Sre', 'Pet'].forEach(function (l, i) {
    out += '<text x="0" y="' + (top + i * 2 * (cell + gap) + 9) + '" font-size="9" fill="var(--muted)">' + esc(t(l)) + '</text>';
  });
  var lastMonth = -1;
  for (var w = 0; w < weeks; w++) {
    for (var d = 0; d < 7; d++) {
      var date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d, 12);
      if (date > today) continue;
      if (d === 0 && date.getMonth() !== lastMonth) {
        lastMonth = date.getMonth();
        var mName = ''; try { mName = date.toLocaleDateString(dateLocale(), { month: 'short' }); } catch (e) {}
        if (w < weeks - 2) out += '<text x="' + (left + w * (cell + gap)) + '" y="10" font-size="9" fill="var(--muted)">' + esc(mName) + '</text>';
      }
      var r = days[dayKey(date.getTime() + DAY_START_H * 36e5)] || { a: 0, n: 0, rv: 0, ok: 0 };
      var lvl = !r.a ? 0 : r.a >= ref ? 4 : r.a >= ref * 0.5 ? 3 : r.a >= ref * 0.25 ? 2 : 1;
      out += '<rect x="' + (left + w * (cell + gap)) + '" y="' + (top + d * (cell + gap)) + '" width="' + cell + '" height="' + cell + '" rx="2" class="lv' + lvl + '" data-tip="' + esc(dayTip(date, r)) + '"/>';
    }
  }
  return out + '</svg>';
}
function statTile(label, value, note) {
  return '<div class="tile"><span class="label">' + esc(label) + '</span><b class="num">' + esc(value) + '</b>' + (note ? '<small>' + esc(note) + '</small>' : '') + '</div>';
}
function viewStats() {
  var now = Date.now(), days = allDays(), st = streak(now), today = dayTotals(dayKey(now)), goal = data.settings.goal || 0;
  var total = { a: 0, ms: 0 }, last30 = { rv: 0, ok: 0 };
  Object.keys(days).forEach(function (k) { total.a += days[k].a; total.ms += days[k].ms; });
  var bars = [];
  for (var i = 29; i >= 0; i--) {
    var dt = dateAt(i), r = days[dayKey(dt.getTime() + DAY_START_H * 36e5)] || { a: 0, n: 0, rv: 0, ok: 0, ms: 0 };
    last30.rv += r.rv; last30.ok += r.ok;
    bars.push({ v: r.a, tip: dayTip(dt, r), label: i === 0 ? t('danas') : shortDate(dt), r: r, d: dt });
  }
  // prognoza: koliko stavki dospeva svakog od sledećih 14 dana (danas uključuje zakasnele)
  var keys = allDeckKeys().concat(allQuizKeys()), fc = [], base = dayStartTs(now);
  for (var k = 0; k < 14; k++) fc.push(0);
  keys.forEach(function (key) {
    var rv = data.rev[key]; if (!rv || rv.st === ST.fresh) return;
    var di = Math.max(0, Math.floor((rv.due - base) / 864e5));
    if (di < 14) fc[di]++;
  });
  var fcVals = fc.map(function (v, j) {
    var lab = j === 0 ? t('danas') : j === 1 ? t('sutra') : shortDate(dateAt(-j));
    return { v: v, tip: lab + ': ' + v + ' ' + pw(v, 'kartica'), label: lab };
  });
  var acc = last30.rv ? Math.round(last30.ok / last30.rv * 100) + '%' : '–';
  // po špilu
  var deckRows = data.decks.map(function (d) {
    var dk = deckKeys(d), sc = stateCounts(dk), tc = todayCounts(dk, now), all = dk.length || 1, learned = sc.young + sc.mature;
    return '<div class="deck-stat"><div class="row-between"><b>' + esc(d.name || t('Bez naziva')) + '</b><span class="num">' + Math.round(learned / all * 100) + '%</span></div>' +
      bar(learned / all * 100, 'thin') +
      '<span class="small-note num">' + esc(stateLine(sc)) + (tc.total ? ' · ' + esc(t('danas {n}', { n: tc.total })) : '') + '</span></div>';
  }).join('');
  // najteže: najviše zaboravljanja
  var hard = Object.keys(data.rev).filter(function (key) { return data.rev[key].l >= 2 && key.indexOf('c:') === 0 && itemOf(key); })
    .sort(function (a, b) { return data.rev[b].l - data.rev[a].l || data.rev[b].d - data.rev[a].d; }).slice(0, 10);
  var hardList = hard.map(function (key) {
    var it = itemOf(key), text = it.n ? plainText(clozeText(it.card.q, it.n, false)) : plainText(it.card.q);
    return '<li><span>' + esc(text.slice(0, 120) || t('Bez naslova')) + '</span><small>' + esc(it.deck.name || '') + ' · ' + esc(t('zaboravljeno {n} puta', { n: data.rev[key].l })) + '</small></li>';
  }).join('');
  ui.hardKeys = hard;
  var f = badgeFacts(now);
  var badges = BADGES.map(function (b) {
    var on = b.test(f);
    return '<div class="badge-item' + (on ? ' on' : '') + '">' + ICON[b.icon] + '<span>' + esc(t(b.label)) + '</span></div>';
  }).join('');
  return '<div class="screen stats-screen">' +
    '<div class="topbar">' + backBtn('home', t('Nazad')) + '</div>' +
    '<div class="head" style="padding-top:0"><h1>' + t('Statistika') + '</h1></div>' +
    '<div class="tiles">' +
      statTile(t('Danas'), String(today.a), goal ? t('cilj {g}', { g: goal }) : '') +
      statTile(t('Dani zaredom'), String(st.cur), t('najviše {n}', { n: st.best })) +
      statTile(t('Tačnost (30 dana)'), acc, t('kod ponavljanja')) +
      statTile(t('Vreme učenja'), fmtDuration(total.ms), t('{n} odgovora', { n: total.a })) +
    '</div>' +
    '<div class="section"><h2 class="sec-title">' + t('Odgovori, poslednjih 30 dana') + '</h2>' +
      barsSvg(bars, { ref: goal, refLabel: t('cilj'), label: t('Odgovori po danu, poslednjih 30 dana') }) +
      tableOf(bars.slice().reverse().filter(function (x) { return x.v; }).map(function (x) {
        return [shortDate(x.d), String(x.r.a), String(x.r.n), x.r.rv ? Math.round(x.r.ok / x.r.rv * 100) + '%' : '–', fmtDuration(x.r.ms)];
      }), [t('Dan'), t('Odgovori'), t('Nove'), t('Tačno'), t('Vreme')]) +
    '</div>' +
    '<div class="section"><h2 class="sec-title">' + t('Kalendar') + '</h2><div class="heat-wrap" id="heatWrap">' + heatmapSvg(days) + '</div>' +
      '<div class="heat-legend"><span>' + t('manje') + '</span><i class="lv0"></i><i class="lv1"></i><i class="lv2"></i><i class="lv3"></i><i class="lv4"></i><span>' + (goal ? t('cilj') : t('više')) + '</span></div></div>' +
    '<div class="section"><h2 class="sec-title">' + t('Ponavljanja u narednih 14 dana') + '</h2>' + barsSvg(fcVals, { label: t('Ponavljanja u narednih 14 dana') }) +
      tableOf(fcVals.filter(function (x) { return x.v; }).map(function (x) { return [x.label, String(x.v)]; }), [t('Dan'), t('Kartice')]) + '</div>' +
    (data.decks.length ? '<div class="section"><h2 class="sec-title">' + t('Po špilu') + '</h2><div class="deck-stats">' + deckRows + '</div></div>' : '') +
    (hard.length ? '<div class="section"><h2 class="sec-title">' + t('Najteže kartice') + '</h2><ol class="hard-list">' + hardList + '</ol>' +
      '<button class="btn" data-act="studyHard">' + t('Uči ove ({n})', { n: hard.length }) + '</button></div>' : '') +
    '<div class="section"><h2 class="sec-title">' + t('Značke') + '</h2><div class="badges">' + badges + '</div></div>' +
    '<div class="tip" id="chartTip" role="status" hidden></div>' +
    '</div>';
}
// oblačić za grafikone: pokazivač preko stubića ili dana, ili dodir
function mountStats() {
  var hw = document.getElementById('heatWrap'); if (hw) hw.scrollLeft = hw.scrollWidth;
  var scr = document.querySelector('.stats-screen'), tip = document.getElementById('chartTip');
  if (!scr || !tip) return;
  function show(e) {
    var el = e.target.closest && e.target.closest('[data-tip]');
    if (!el) { tip.hidden = true; return; }
    tip.textContent = el.getAttribute('data-tip'); tip.hidden = false;
    var r = scr.getBoundingClientRect(), w = tip.offsetWidth;
    tip.style.left = Math.max(4, Math.min(r.width - w - 4, e.clientX - r.left - w / 2)) + 'px';
    tip.style.top = (e.clientY - r.top + scr.scrollTop - tip.offsetHeight - 14) + 'px';
  }
  scr.addEventListener('pointermove', show);
  scr.addEventListener('pointerdown', show);
  scr.addEventListener('pointerleave', function () { tip.hidden = true; });
}
