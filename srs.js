/* Kartice — raspored ponavljanja (FSRS, biblioteka vendor/ts-fsrs.umd.js)
   Svaka stavka za učenje ima stanje u data.rev[ključ]; stavka bez stanja je nova.
   Ključ stavke:  'c:<špil>:<kartica>'      kartica pitanje/odgovor
                  'c:<špil>:<kartica>:<n>'  n-ta praznina kartice sa prazninama (od 1)
                  'q:<kviz>:<pitanje>'      pitanje iz kviza
   Stanje je sažeto: { due, s (stabilnost), d (težina), el, sd, r (ponavljanja), l (zaboravljanja),
   ls (korak učenja), st (0 nova, 1 učenje, 2 ponavljanje, 3 ponovno učenje), lr (poslednji odgovor) } */

var RATING = { again: 1, hard: 2, good: 3, easy: 4 };
var ST = { fresh: 0, learning: 1, review: 2, relearning: 3 };
var DAY_START_H = 4;              // dan za učenje počinje u 4 ujutru (učenje posle ponoći ide u prethodni dan)
var LEARN_AHEAD = 20 * 60000;     // stavke u učenju koje dospevaju u narednih 20 min ulaze u tekući krug
var REQUEUE_GAP = 4;              // "Ponovo" vraća karticu posle ovoliko drugih

/* ---------- dani ---------- */
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function dayKey(ts) {
  var d = new Date((ts || Date.now()) - DAY_START_H * 36e5);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function dayStartTs(ts) {
  var d = new Date((ts || Date.now()) - DAY_START_H * 36e5);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAY_START_H).getTime();
}
function endOfDay(ts) { return dayStartTs(ts) + 864e5; }

/* ---------- stavke ---------- */
var CLOZE_RE = /\{\{([\s\S]+?)\}\}/g;
function clozeCount(text) { var m = String(text || '').match(CLOZE_RE); return m ? m.length : 0; }
function isCloze(c) { return c.type === 'cloze' && clozeCount(c.q) > 0; }
function cardKeys(d, c) {
  if (isCloze(c)) {
    var out = [], n = clozeCount(c.q);
    for (var i = 1; i <= n; i++) out.push('c:' + d.id + ':' + c.id + ':' + i);
    return out;
  }
  return ['c:' + d.id + ':' + c.id];
}
function deckKeys(d, cards) {
  var out = [];
  (cards || d.cards).forEach(function (c) { out = out.concat(cardKeys(d, c)); });
  return out;
}
function quizKeys(z) { return playable(z).map(function (q) { return 'q:' + z.id + ':' + q.id; }); }
function allDeckKeys() { var out = []; data.decks.forEach(function (d) { out = out.concat(deckKeys(d)); }); return out; }
function allQuizKeys() { var out = []; data.quizzes.forEach(function (z) { out = out.concat(quizKeys(z)); }); return out; }
// šta je iza ključa: { kind: 'c', deck, card, n } ili { kind: 'q', quiz, q }; null ako više ne postoji
function itemOf(key) {
  var p = String(key).split(':');
  if (p[0] === 'c') {
    var d = data.decks.find(function (x) { return x.id === p[1]; });
    var c = d && d.cards.find(function (x) { return x.id === p[2]; });
    return c ? { kind: 'c', deck: d, card: c, n: p[3] ? +p[3] : 0 } : null;
  }
  if (p[0] === 'q') {
    var z = data.quizzes.find(function (x) { return x.id === p[1]; });
    var q = z && z.questions.find(function (x) { return x.id === p[2]; });
    return q ? { kind: 'q', quiz: z, q: q } : null;
  }
  return null;
}

/* ---------- FSRS ---------- */
var srsF = null, srsRet = null;
function srs() {
  var r = data.settings.retention || 0.9;
  if (!srsF || srsRet !== r) {
    srsF = FSRS.fsrs(FSRS.generatorParameters({ request_retention: r, enable_fuzz: true, maximum_interval: 3650 }));
    srsRet = r;
  }
  return srsF;
}
function toCard(rv, now) {
  if (!rv) return FSRS.createEmptyCard(new Date(now));
  return {
    due: new Date(rv.due), stability: rv.s, difficulty: rv.d, elapsed_days: rv.el || 0, scheduled_days: rv.sd || 0,
    reps: rv.r || 0, lapses: rv.l || 0, learning_steps: rv.ls || 0, state: rv.st, last_review: rv.lr ? new Date(rv.lr) : undefined
  };
}
function round3(x) { return Math.round(x * 1000) / 1000; }
function fromCard(c, now) {
  return { due: +c.due, s: round3(c.stability), d: round3(c.difficulty), el: c.elapsed_days, sd: c.scheduled_days,
    r: c.reps, l: c.lapses, ls: c.learning_steps, st: c.state, lr: c.last_review ? +c.last_review : now };
}
function revState(key) { var rv = data.rev[key]; return rv ? rv.st : ST.fresh; }
function isFresh(key) { return !data.rev[key] || data.rev[key].st === ST.fresh; }
function isDue(key, now) {
  var rv = data.rev[key];
  if (!rv || rv.st === ST.fresh) return false;
  return rv.st === ST.review ? rv.due < endOfDay(now) : rv.due <= now + LEARN_AHEAD;
}
// za svaku ocenu: za koliko se stavka vraća (tekst za dugme)
function srsPreview(key, now) {
  var rec = srs().repeat(toCard(data.rev[key], now), new Date(now)), out = {};
  [1, 2, 3, 4].forEach(function (g) { out[g] = fmtInterval(+rec[g].card.due - now); });
  return out;
}
// ocena: novo stanje se upisuje u data.rev; vraća prethodno stanje (za "Poništi")
function srsRate(key, g, now) {
  var prev = data.rev[key] ? Object.assign({}, data.rev[key]) : null;
  var next = srs().next(toCard(prev, now), new Date(now), g).card;
  data.rev[key] = fromCard(next, now);
  return prev;
}
function fmtInterval(ms) {
  var min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return t('{n} min', { n: min });
  var h = Math.round(min / 60);
  if (h < 24) return t('{n} h', { n: h });
  var d = Math.round(h / 24);
  if (d < 31) return t('{n} d', { n: d });
  if (d < 365) return t('{n} mes', { n: Math.round(d / 30) });
  var y = d / 365;
  return t('{n} g', { n: (Math.round(y * 10) / 10).toString().replace('.', LANG === 'en' ? '.' : ',') });
}

/* ---------- red za danas ----------
   Prvo stavke u učenju (dospele), pa ponavljanja, a nove se ubacuju između ponavljanja.
   Granice: data.settings.newPerDay novih i maxReviews ponavljanja dnevno (sa svih uređaja). */
function todayLimits(now, bonusNew) {
  var s = dayTotals(dayKey(now));
  return {
    fresh: Math.max(0, (data.settings.newPerDay || 0) - s.n) + (bonusNew || 0),
    review: Math.max(0, (data.settings.maxReviews || 0) - s.rv)
  };
}
function splitDue(keys, now) {
  var learn = [], review = [], fresh = [];
  keys.forEach(function (k) {
    var rv = data.rev[k];
    if (!rv || rv.st === ST.fresh) fresh.push(k);
    else if (isDue(k, now)) (rv.st === ST.review ? review : learn).push(k);
  });
  var byDue = function (a, b) { return data.rev[a].due - data.rev[b].due; };
  learn.sort(byDue); review.sort(byDue);
  return { learn: learn, review: review, fresh: fresh };
}
function todayCounts(keys, now) {
  now = now || Date.now();
  var s = splitDue(keys, now), lim = todayLimits(now);
  return { learn: s.learn.length, review: Math.min(s.review.length, lim.review), fresh: Math.min(s.fresh.length, lim.fresh),
    total: s.learn.length + Math.min(s.review.length, lim.review) + Math.min(s.fresh.length, lim.fresh) };
}
function buildQueue(keys, now, opts) {
  opts = opts || {};
  var s = splitDue(keys, now), lim = todayLimits(now, opts.bonusNew);
  var review = s.review.slice(0, lim.review);
  var fresh = s.fresh.slice(0, lim.fresh);
  if (opts.shuffleNew) fresh = shuffled(fresh);
  // nove ravnomerno kroz ponavljanja
  var out = s.learn.slice(), every = fresh.length ? Math.max(1, Math.floor(review.length / fresh.length)) : 0, fi = 0;
  review.forEach(function (k, i) {
    out.push(k);
    if (every && (i + 1) % every === 0 && fi < fresh.length) out.push(fresh[fi++]);
  });
  while (fi < fresh.length) out.push(fresh[fi++]);
  // ista kartica (praznine iste kartice) ne ide dvaput zaredom
  for (var i = 1; i < out.length; i++) {
    if (sameCard(out[i], out[i - 1])) {
      for (var j = i + 1; j < out.length; j++) if (!sameCard(out[j], out[i - 1])) { var x = out[i]; out[i] = out[j]; out[j] = x; break; }
    }
  }
  return out;
}
function sameCard(a, b) { return a.split(':').slice(0, 3).join(':') === b.split(':').slice(0, 3).join(':'); }
// sledeći rok posle danas: { ts, n } — koliko stavki dospeva prvog sledećeg dana
function nextDue(keys, now) {
  var end = endOfDay(now), first = null;
  keys.forEach(function (k) { var rv = data.rev[k]; if (rv && rv.st !== ST.fresh && rv.due >= end && (first === null || rv.due < first)) first = rv.due; });
  if (first === null) return null;
  var dk = dayKey(first), n = 0;
  keys.forEach(function (k) { var rv = data.rev[k]; if (rv && rv.st !== ST.fresh && dayKey(rv.due) === dk) n++; });
  return { ts: first, n: n };
}
// raspodela stavki po stanju: nove / u učenju / naučene (interval bar 21 dan = "zrele")
function stateCounts(keys) {
  var out = { fresh: 0, learning: 0, young: 0, mature: 0 };
  keys.forEach(function (k) {
    var rv = data.rev[k];
    if (!rv || rv.st === ST.fresh) out.fresh++;
    else if (rv.st !== ST.review) out.learning++;
    else if ((rv.sd || 0) >= 21) out.mature++;
    else out.young++;
  });
  return out;
}

/* ---------- migracija iz verzije 12 ----------
   Kartice i pitanja označeni kao naučeni ulaze kao naučeni, sa rokovima raspoređenim kroz sledećih 7 dana,
   da prvog dana ne bi stiglo sve odjednom. Ostali su nove stavke. */
function srsMigrateKnown(d) {
  var now = Date.now();
  function learned(key) {
    var days = 1 + Math.floor(Math.random() * 7), stab = 3 + Math.random() * 7;
    d.rev[key] = { due: dayStartTs(now) + days * 864e5 + Math.floor(Math.random() * 6) * 36e5, s: round3(stab), d: 5, el: 0, sd: days,
      r: 1, l: 0, ls: 0, st: ST.review, lr: now - 864e5 };
  }
  (d.decks || []).forEach(function (k) {
    (k.cards || []).forEach(function (c) { if (k.known && k.known[c.id]) learned('c:' + k.id + ':' + c.id); });
  });
  (d.quizzes || []).forEach(function (z) {
    (z.questions || []).forEach(function (q) { if (z.known && z.known[q.id]) learned('q:' + z.id + ':' + q.id); });
  });
}
// stanja stavki koje više ne postoje (obrisane kartice, praznine) se uklanjaju
function srsPrune() {
  var alive = {};
  allDeckKeys().concat(allQuizKeys()).forEach(function (k) { alive[k] = true; });
  // nedovršena pitanja u kvizu nisu u playable(), ali im se stanje čuva
  data.quizzes.forEach(function (z) { z.questions.forEach(function (q) { alive['q:' + z.id + ':' + q.id] = true; }); });
  var n = 0;
  Object.keys(data.rev).forEach(function (k) { if (!alive[k]) { delete data.rev[k]; n++; } });
  return n;
}
