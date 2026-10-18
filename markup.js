/* Kartice — formatiranje teksta i formule
   Podskup Markdown-a:  # naslov, ## podnaslov, - ili • ili 1. stavka liste, prazan red = novi pasus,
   **podebljano**, *kurziv*, ==označeno==, `kod`, [tekst](https://…), adrese https://…,
   $formula$ i $$formula u svom redu$$ (KaTeX, učitava se tek kad zatreba), \$ = običan znak $.
   Bezbednost: sav tekst se prvo escape-uje (esc iz app.js), pa se dodaju samo ove oznake;
   linkovi su samo http(s). Ništa iz teksta ne postaje atribut ili oznaka koju nismo mi napisali. */

// privremene oznake za delove koji se ne formatiraju dalje (kod, formula, link, praznina)
var MK = '\u0001';
function mkToken(store, html) { store.push(html); return MK + (store.length - 1) + MK; }
function mkRestore(s, store) {
  return s.replace(/\u0001(\d+)\u0001/g, function (_, i) { return store[+i]; });
}

function mdInline(s) {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<b>$1</b>')
    .replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<i>$2</i>')
    .replace(/(^|[^_\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![_\w])/g, '$1<i>$2</i>');
}

/* tekst → HTML. opts.inline: bez pasusa, naslova i lista (npr. ponuđeni odgovori u kvizu) */
function renderMarkup(text, opts) {
  opts = opts || {};
  var store = [];
  var s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  // praznine iz clozeText(): \u0005hint\u0005 je skriveno mesto, \u0006tekst\u0006 otkriven odgovor
  s = s.replace(/\u0005([^\u0005]*)\u0005/g, function (_, hint) {
    return mkToken(store, '<span class="cloze-gap">[' + (hint ? esc(hint) : '…') + ']</span>');
  });
  s = s.replace(/\u0006([^\u0006]*)\u0006/g, function (_, inner) {
    return mkToken(store, '<mark class="cloze-ans">' + renderMarkup(inner, { inline: true }) + '</mark>');
  });
  s = s.replace(/`([^`\n]+)`/g, function (_, code) { return mkToken(store, '<code>' + esc(code) + '</code>'); });
  s = s.replace(/\\\$/g, function () { return mkToken(store, '$'); });
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, function (_, tex) {
    return mkToken(store, '<span class="math display" data-tex="' + esc(tex.trim()) + '">' + esc(tex.trim()) + '</span>');
  });
  s = s.replace(/\$(?=[^\s$])([^$\n]*?[^\s$])\$(?!\d)/g, function (_, tex) {
    return mkToken(store, '<span class="math" data-tex="' + esc(tex) + '">' + esc(tex) + '</span>');
  });
  s = esc(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, label, url) {
    return mkToken(store, '<a href="' + url + '" target="_blank" rel="noopener">' + mdInline(label) + '</a>');
  });
  s = s.replace(/https?:\/\/[^\s<\u0001]+[^\s<\u0001.,;:!?)]/g, function (url) {
    return mkToken(store, '<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>');
  });
  if (opts.inline) return mkRestore(mdInline(s).replace(/\n/g, '<br>'), store);

  var out = [], para = [], list = null;
  function flushPara() { if (para.length) { out.push('<p>' + para.map(mdInline).join('<br>') + '</p>'); para = []; } }
  function flushList() { if (list) { out.push('<' + list.tag + '>' + list.items.map(function (l) { return '<li>' + mdInline(l) + '</li>'; }).join('') + '</' + list.tag + '>'); list = null; } }
  s.split('\n').forEach(function (raw) {
    var line = raw.trim(), m;
    if (!line) { flushPara(); flushList(); return; }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { flushPara(); flushList(); var h = m[1].length + 1; out.push('<h' + h + '>' + mdInline(m[2]) + '</h' + h + '>'); return; }
    if ((m = line.match(/^[-•*]\s+(.*)$/))) { flushPara(); if (list && list.tag !== 'ul') flushList(); list = list || { tag: 'ul', items: [] }; list.items.push(m[1]); return; }
    if ((m = line.match(/^\d+[.)]\s+(.*)$/))) { flushPara(); if (list && list.tag !== 'ol') flushList(); list = list || { tag: 'ol', items: [] }; list.items.push(m[1]); return; }
    flushList(); para.push(line);
  });
  flushPara(); flushList();
  return mkRestore(out.join(''), store);
}

// isti tekst bez oznaka: za čitanje naglas, pretragu i kratke prikaze
function plainText(text) {
  return String(text || '')
    .replace(/\u0005[^\u0005]*\u0005/g, ' … ')
    .replace(/[\u0006]/g, '')
    .replace(/\{\{([\s\S]+?)(::[\s\S]*?)?\}\}/g, '$1')
    .replace(/\$\$?([^$]+)\$\$?/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')
    .replace(/\*\*|==|`/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/^\s*(#{1,3}|[-•*]|\d+[.)])\s+/gm, '')
    .trim();
}

/* ---------- praznine ----------
   Tekst "Ruter radi na {{mrežnom}} sloju" daje po jednu stavku za svaku prazninu.
   {{odgovor::nagoveštaj}} umesto […] pokazuje [nagoveštaj]. */
function clozeParts(text) {
  var list = [];
  String(text || '').replace(CLOZE_RE, function (_, inner) {
    var k = inner.indexOf('::');
    list.push(k >= 0 ? { ans: inner.slice(0, k), hint: inner.slice(k + 2) } : { ans: inner, hint: '' });
    return _;
  });
  return list;
}
// tekst za prikaz: n-ta praznina je skrivena (ili otkrivena), ostale se vide kao običan tekst
function clozeText(text, n, reveal) {
  var i = 0;
  return String(text || '').replace(CLOZE_RE, function (_, inner) {
    i++;
    var k = inner.indexOf('::'), ans = k >= 0 ? inner.slice(0, k) : inner, hint = k >= 0 ? inner.slice(k + 2) : '';
    if (i !== n) return ans;
    return reveal ? '\u0006' + ans + '\u0006' : '\u0005' + hint + '\u0005';
  });
}

/* ---------- formule (KaTeX) ---------- */
var katexCss = false;
function renderMath(root) {
  var els = (root || document).querySelectorAll('.math:not([data-ok])');
  if (!els.length) return;
  if (!katexCss) {
    katexCss = true;
    var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'vendor/katex/katex.min.css';
    document.head.appendChild(l);
  }
  loadScript('vendor/katex/katex.min.js').then(function () {
    els.forEach(function (el) {
      if (!el.isConnected || el.dataset.ok) return;
      try {
        window.katex.render(el.dataset.tex, el, { displayMode: el.classList.contains('display'), throwOnError: false, output: 'html' });
        el.dataset.ok = '1';
      } catch (e) {}
    });
  }).catch(function () {});
}

/* ---------- traka alata za pisanje ----------
   Dugmad rade nad poslednjim poljem koje je imalo fokus (ui.mdTarget). */
var MD_TOOLS = [
  ['b', '<b>B</b>', 'Podebljano'], ['i', '<i>I</i>', 'Kurziv'], ['mark', '<span class="mk-mark">ab</span>', 'Označeno'],
  ['list', '•≡', 'Lista'], ['math', '∑', 'Formula'], ['cloze', '[…]', 'Praznina']
];
function mdToolbar(tools) {
  return '<div class="md-bar" role="toolbar" aria-label="' + esc(t('Formatiranje')) + '">' + MD_TOOLS.filter(function (x) { return !tools || tools.indexOf(x[0]) >= 0; }).map(function (x) {
    return '<button type="button" data-act="md" data-arg="' + x[0] + '" title="' + esc(t(x[2])) + '" aria-label="' + esc(t(x[2])) + '">' + x[1] + '</button>';
  }).join('') + '</div>';
}
function mdApply(kind, el) {
  if (!el) return;
  var v = el.value, a = el.selectionStart, b = el.selectionEnd, sel = v.slice(a, b), ins, ca, cb;
  var wrap = { b: ['**', '**'], i: ['*', '*'], mark: ['==', '=='], math: ['$', '$'], cloze: ['{{', '}}'] }[kind];
  if (wrap) {
    ins = wrap[0] + sel + wrap[1];
    ca = a + wrap[0].length; cb = ca + sel.length;
  } else if (kind === 'list') {
    // cela linija (ili označene linije) dobija "- "
    var ls = v.lastIndexOf('\n', a - 1) + 1; a = ls;
    sel = v.slice(a, b);
    ins = sel.split('\n').map(function (l) { return /^\s*[-•*]\s/.test(l) ? l : '- ' + l; }).join('\n');
    ca = a; cb = a + ins.length;
  } else return;
  el.focus();
  el.setRangeText ? el.setRangeText(ins, a, b, 'end') : (el.value = v.slice(0, a) + ins + v.slice(b));
  el.setSelectionRange(ca, cb);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/* ---------- čitanje naglas (Web Speech API) ----------
   Jezik je po špilu (deck.lang). Ako uređaj nema srpski glas, koristi se hrvatski ili bosanski,
   koji latinicu čitaju skoro isto. Izabrani glas po jeziku je u data.settings.voices. */
var TTS_LANGS = [['sr-RS', 'Srpski'], ['hr-HR', 'Hrvatski'], ['en-US', 'Engleski'], ['en-GB', 'Engleski (UK)'], ['de-DE', 'Nemački'],
  ['fr-FR', 'Francuski'], ['it-IT', 'Italijanski'], ['es-ES', 'Španski'], ['ru-RU', 'Ruski']];
var TTS_FALLBACK = { sr: ['sr', 'hr', 'bs'], hr: ['hr', 'bs', 'sr'], bs: ['bs', 'hr', 'sr'] };
function ttsAvailable() { return typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined'; }
function langOf(v) { return String(v.lang || '').replace('_', '-').toLowerCase(); }
// glasovi koji odgovaraju jeziku, najbolji prvi
function voicesFor(lang) {
  if (!ttsAvailable()) return [];
  var vs = speechSynthesis.getVoices(), base = lang.split('-')[0].toLowerCase(), out = [];
  (TTS_FALLBACK[base] || [base]).forEach(function (p) {
    vs.forEach(function (v) { var l = langOf(v); if ((l === lang.toLowerCase() || l.split('-')[0] === p) && out.indexOf(v) < 0) out.push(v); });
  });
  return out;
}
function pickVoice(lang) {
  var list = voicesFor(lang), want = (data.settings.voices || {})[lang];
  return list.find(function (v) { return v.voiceURI === want; }) || list[0] || null;
}
function speakText(text, lang) {
  if (!ttsAvailable() || !text) return;
  speechSynthesis.cancel();
  var u = new SpeechSynthesisUtterance(text), v = pickVoice(lang);
  u.lang = v ? v.lang : lang;
  if (v) u.voice = v;
  u.rate = data.settings.ttsRate || 1;
  speechSynthesis.speak(u);
}
function speakSide(side) {
  var it = itemOf(ui.order[ui.i]); if (!it) return;
  var sd = studySides(it), part = side === 'back' ? sd.back : sd.front;
  var text = plainText(part.md) + (side === 'back' && part.extra ? '. ' + plainText(part.extra) : '');
  speakText(text, it.deck.lang || 'sr-RS');
}
function autoSpeak() {
  if (ttsAvailable()) speechSynthesis.cancel();
  if (data.settings.ttsAuto && ui.screen === 'cards') speakSide(ui.flipped ? 'back' : 'front');
}
// iOS i Chrome učitavaju spisak glasova naknadno; podešavanja se tada iscrtaju ponovo
if (ttsAvailable()) speechSynthesis.addEventListener && speechSynthesis.addEventListener('voiceschanged', function () {
  if (typeof ui !== 'undefined' && ui.screen === 'settings') render(true);
});
