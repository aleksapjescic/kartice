/* Kartice — AI asistent (Claude ili Gemini)
   Pravi kartice i pitanja za kviz iz beleški, PDF-a, Word-a i slika, i objašnjava odgovore.
   Claude: Anthropic API iz pregledača tvojim ključem (zvanični SDK, vendor/anthropic.min.js).
   Gemini: Google Gemini API (REST, generativelanguage.googleapis.com) tvojim ključem iz AI Studija.
   Ključevi su samo na ovom uređaju (localStorage 'kartice.aiKey' i 'kartice.geminiKey'): nisu u data,
   pa ne idu ni u rezervnu kopiju ni u sinhronizaciju. */

var AI_KEY = 'kartice.aiKey', AI_USAGE = 'kartice.aiUsage';
// cene u dolarima po milion tokena (ulaz, izlaz, čitanje iz keša); fallback: server-side fallback pri odbijanju
var AI_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', inp: 4, out: 20, cache: 0.2, fallback: true },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', inp: 2, out: 10, cache: 0.2, fallback: true },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', inp: 0.1, out: 0.5, cache: 0.01, fallback: false }
];
var AI_MAX_PDF = 32 * 1048576, AI_MAX_PAGES = 600;

function aiKey() { try { return localStorage.getItem(AI_KEY) || ''; } catch (e) { return ''; } }

/* Izvor ključa: 'own' = tvoj ključ na ovom uređaju (Claude ili Gemini), 'app' = ključ aplikacije preko
   servera (supabase/functions/ai, uvek Gemini), za prijavljene, sa dnevnim limitom koji zadaje admin.
   Izbor se pamti po uređaju, kao i ključevi. Dok nije izabrano: tvoj ključ ako postoji, inače aplikacijin. */
var AI_SOURCE = 'kartice.aiSource';
function appAiConfigured() { return typeof syncConfigured === 'function' && syncConfigured(); }
function aiKeySource() {
  if (!appAiConfigured()) return 'own';
  var v = ''; try { v = localStorage.getItem(AI_SOURCE) || ''; } catch (e) {}
  if (v === 'app' || v === 'own') return v;
  return aiKey() || geminiKey() ? 'own' : 'app';
}
function aiSetSource(v) {
  try { localStorage.setItem(AI_SOURCE, v === 'app' ? 'app' : 'own'); } catch (e) {}
  if (v === 'app' && typeof sync !== 'undefined' && sync.user && typeof syncLoadProfile === 'function') syncLoadProfile();
  render(true);
}
function aiProvider() { return aiKeySource() === 'app' || data.settings.aiProvider === 'gemini' ? 'gemini' : 'claude'; }
// za ključ aplikacije dovoljna je prijava; blokadu, prekidač i limit proverava server i javlja jasnu poruku
function aiReady() {
  if (aiKeySource() === 'app') return !!(typeof sync !== 'undefined' && sync.user);
  return aiProvider() === 'gemini' ? !!geminiKey() : !!aiKey();
}
function aiName() { return aiProvider() === 'gemini' ? 'Gemini' : 'Claude'; }

// poziv preko servera aplikacije; odgovor je isti kao od Gemini API-ja
async function appAiFetch(body) {
  var c = await syncClient(), s = (await c.auth.getSession()).data.session;
  if (!s) throw { app: true, reason: 'auth' };
  var r;
  try {
    r = await fetch(SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1/ai', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + s.access_token, apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) { throw { app: true, reason: navigator.onLine ? 'upstream' : 'offline' }; }
  var j = null;
  try { j = await r.json(); } catch (e) {}
  var used = r.headers.get('x-ai-used'), lim = r.headers.get('x-ai-limit');
  if (sync.ai && used !== null && used !== '') { sync.ai.used = +used; sync.ai.limit = lim ? +lim : null; }
  if (!r.ok) {
    if (j && typeof j.error === 'string') {
      if (sync.ai && j.error === 'limit') { sync.ai.used = j.used; sync.ai.limit = j.limit; }
      if (sync.ai && j.error === 'blocked') sync.ai.blocked = true;
      if (sync.ai && j.error === 'disabled') sync.ai.on = false;
      throw { app: true, reason: j.error, status: r.status, used: j.used, limit: j.limit };
    }
    throw { app: true, gemini: true, status: r.status, message: (j && j.error && j.error.message) || r.statusText || '' };
  }
  return j;
}

/* ---------- Gemini ----------
   Spisak modela se učitava tvojim ključem (Proveri ključ), pa se ne oslanja na ime modela koje bi
   moglo da zastari; podrazumevan je najnoviji stabilan "flash" model, koji ima besplatan nivo. */
var GEMINI_KEY = 'kartice.geminiKey', GEMINI_LIST = 'kartice.geminiModels';
var GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/';
var GEMINI_MAX_PDF = 14 * 1048576;   // ceo zahtev sa ugrađenim fajlom sme do 20 MB, a base64 ga uveća za trećinu
function geminiKey() { try { return localStorage.getItem(GEMINI_KEY) || ''; } catch (e) { return ''; } }
function geminiModels() { try { return JSON.parse(localStorage.getItem(GEMINI_LIST) || '[]'); } catch (e) { return []; } }
function geminiModel() { return data.settings.geminiModel || (geminiModels()[0] || {}).id || 'gemini-3.8-flash'; }
async function geminiFetch(path, body) {
  if (body && aiKeySource() === 'app') return appAiFetch(body);
  var r = await fetch(GEMINI_API + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'x-goog-api-key': geminiKey(), 'Content-Type': 'application/json' } : { 'x-goog-api-key': geminiKey() },
    body: body ? JSON.stringify(body) : undefined
  });
  var j = null;
  try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw { status: r.status, gemini: true, message: (j && j.error && j.error.message) || r.statusText || '' };
  return j;
}
// modeli za tekst; rang: noviji, pa flash (besplatan nivo je izdašniji), bez pregleda i eksperimenata
function geminiRank(id) {
  var v = /gemini-(\d+(?:\.\d+)?)/.exec(id), ver = v ? parseFloat(v[1]) : 0;
  var kind = /flash-lite/.test(id) ? 1 : /flash/.test(id) ? 3 : /pro/.test(id) ? 2 : 0;
  return ver * 10 + kind - (/preview|exp/.test(id) ? 6 : 0);
}
async function geminiLoadModels() {
  var j = await geminiFetch('models?pageSize=1000');
  var list = (j.models || []).filter(function (m) { return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0; })
    .map(function (m) { return { id: String(m.name).replace(/^models\//, ''), name: m.displayName || m.name }; })
    .filter(function (m) { return /^gemini-/.test(m.id) && !/embedding|tts|image|live|audio|native|aqa|robotics|computer/i.test(m.id); })
    .sort(function (a, b) { return geminiRank(b.id) - geminiRank(a.id); });
  try { localStorage.setItem(GEMINI_LIST, JSON.stringify(list)); } catch (e) {}
  if (list.length && !list.some(function (m) { return m.id === data.settings.geminiModel; })) { data.settings.geminiModel = list[0].id; save(); }
  return list;
}
// blokovi u Claude obliku (aiSource) → delovi poruke za Gemini
function geminiParts(blocks) {
  return blocks.map(function (b) {
    if (b.type === 'text') return { text: b.text };
    if (b.type === 'document' || b.type === 'image') return { inlineData: { mimeType: b.source.media_type, data: b.source.data } };
    return null;
  }).filter(Boolean);
}
// šema odgovora u obliku koji Gemini prima (OpenAPI podskup: tipovi velikim slovima)
var GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    cards: { type: 'ARRAY', items: { type: 'OBJECT', properties: { q: { type: 'STRING' }, a: { type: 'STRING' } }, required: ['q', 'a'] } },
    questions: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      q: { type: 'STRING' }, options: { type: 'ARRAY', items: { type: 'STRING' } }, correct: { type: 'INTEGER' }
    }, required: ['q', 'options', 'correct'] } }
  },
  required: ['cards', 'questions']
};
// jedan poziv: { system, parts, json } → { text, tokens }
async function geminiCall(o) {
  var body = { contents: [{ role: 'user', parts: o.parts }], generationConfig: { maxOutputTokens: o.maxTokens || 32768 } };
  if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
  if (o.json) { body.generationConfig.responseMimeType = 'application/json'; body.generationConfig.responseSchema = GEMINI_SCHEMA; }
  var j = await geminiFetch('models/' + encodeURIComponent(geminiModel()) + ':generateContent', body);
  var u = j.usageMetadata || {}, tokens = (u.promptTokenCount || 0) + (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
  aiUsageAdd(0, tokens);
  if (j.promptFeedback && j.promptFeedback.blockReason) throw { refusal: true };
  var c = j.candidates && j.candidates[0];
  if (!c) throw { refusal: true };
  if (/SAFETY|PROHIBITED|RECITATION|BLOCKLIST|SPII/.test(c.finishReason || '')) throw { refusal: true };
  var text = ((c.content && c.content.parts) || []).filter(function (p) { return p.text && !p.thought; }).map(function (p) { return p.text; }).join('');
  // partial: prekinut odgovor se prihvata (objašnjenje), inače je greška (JSON ne bi bio ceo)
  if (c.finishReason === 'MAX_TOKENS' && !(o.partial && text.trim())) throw { tooLong: true };
  return { text: text, tokens: tokens };
}
function aiModel() { return AI_MODELS.find(function (m) { return m.id === data.settings.aiModel; }) || AI_MODELS[0]; }
function aiClient() {
  return loadScript('vendor/anthropic.min.js').then(function () {
    return new window.AnthropicSDK.Anthropic({ apiKey: aiKey(), dangerouslyAllowBrowser: true, maxRetries: 2 });
  });
}
// cena poziva iz usage: ulaz, upis u keš (1,25×), čitanje iz keša, izlaz
function aiCost(u, m) {
  if (!u) return 0;
  return ((u.input_tokens || 0) * m.inp + (u.cache_creation_input_tokens || 0) * m.inp * 1.25 +
    (u.cache_read_input_tokens || 0) * m.cache + (u.output_tokens || 0) * m.out) / 1e6;
}
function fmtUsd(x) { return '$' + (x < 0.01 ? x.toFixed(4) : x.toFixed(2)); }
// potrošnja u tekućem mesecu, samo na ovom uređaju
function aiUsageGet() {
  var month = new Date().toISOString().slice(0, 7);
  try { var u = JSON.parse(localStorage.getItem(AI_USAGE) || 'null'); if (u && u.month === month) return u; } catch (e) {}
  return { month: month, usd: 0, calls: 0, tokens: 0 };
}
function aiUsageAdd(usd, tokens) {
  var u = aiUsageGet(); u.usd += usd || 0; u.calls++; u.tokens = (u.tokens || 0) + (tokens || 0);
  try { localStorage.setItem(AI_USAGE, JSON.stringify(u)); } catch (e) {}
}
// greška API-ja → poruka na srpskom
function aiErrorText(e) {
  var st = e && e.status;
  if (e && e.refusal) return t('{ai} je odbio ovaj zahtev. Probaj sa drugim delom materijala.', { ai: aiName() });
  if (e && e.app && e.reason) {
    if (e.reason === 'auth') return t('Prijavi se da koristiš AI bez svog ključa.');
    if (e.reason === 'blocked') return t('Tvoj nalog je blokiran za AI aplikacije. Možeš da upišeš svoj ključ u Podešavanja → AI asistent.');
    if (e.reason === 'disabled') return t('Besplatan AI je trenutno isključen. Upiši svoj ključ u Podešavanja → AI asistent.');
    if (e.reason === 'limit') return t('Potrošio si današnji limit ({n}). Sutra se obnavlja, ili upiši svoj ključ.', { n: e.limit || 0 });
    if (e.reason === 'too_big') return t('Materijal je prevelik. Izaberi manje strana.');
    if (e.reason === 'offline') return t('Nema veze sa internetom.');
    return t('AI aplikacije trenutno ne radi. Probaj kasnije ili upiši svoj ključ.');
  }
  if (e && e.app && e.gemini) {
    if (st === 429) return t('Zajednička besplatna kvota je trenutno potrošena. Probaj kasnije ili upiši svoj ključ.');
    if (st === 400 || st === 401 || st === 403 || st === 404) return t('AI aplikacije nije ispravno podešen. Javi administratoru.');
    if (st >= 500) return t('Gemini je trenutno preopterećen. Probaj ponovo za par minuta.');
  }
  if (e && e.gemini) {
    if ((st === 400 && /api key/i.test(e.message)) || st === 401) return t('Gemini ključ nije ispravan. Proveri ga u Podešavanjima → AI asistent.');
    if (st === 403) return t('Ovaj Gemini ključ nema dozvolu. U AI Studiju napravi novi ključ.');
    if (st === 429) return t('Dostignuto je besplatno ograničenje za Gemini. Sačekaj minut, ili do sutra ako je potrošena dnevna kvota.');
    if (st === 404) return t('Izabrani Gemini model više ne postoji. U Podešavanjima → AI asistent klikni Proveri.');
    if (st >= 500) return t('Gemini je trenutno preopterećen. Probaj ponovo za par minuta.');
    if (st === 400) return t('Zahtev nije prihvaćen: {m}', { m: e.message || '' });
  }
  if (e && e.tooLong) return t('Odgovor je bio predugačak. Smanji broj kartica ili izaberi manje strana.');
  if (st === 401) return t('API ključ nije ispravan. Proveri ga u Podešavanjima → AI asistent.');
  if (st === 403) return t('Ovaj ključ nema dozvolu za izabrani model.');
  if (st === 429) return t('Previše zahteva ili je potrošen kredit. Sačekaj malo ili proveri stanje na console.anthropic.com.');
  if (st === 529 || st === 503) return t('Claude je trenutno preopterećen. Probaj ponovo za par minuta.');
  if (st === 413) return t('Dokument je prevelik. Izaberi manji opseg strana.');
  if (st === 400) return t('Zahtev nije prihvaćen: {m}', { m: (e.error && e.error.error && e.error.error.message) || e.message || '' });
  if (!navigator.onLine || (e && /connection|network|fetch/i.test(e.name + ' ' + e.message))) return t('Nema veze sa internetom.');
  return t('Nešto nije u redu: {m}', { m: (e && e.message) || '' });
}

/* ---------- izvor: šta se šalje Claude-u iz beleške ----------
   PDF ide kao dokument (Claude vidi i slike i tabele), a izabran opseg strana kao izvučen tekst.
   Word i tekst idu kao tekst, slike kao slike (JPEG/PNG/WebP/GIF; veće se smanje). */
function parseRange(s, max) {
  var m = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(s || '');
  if (!m) return null;
  var a = Math.max(1, +m[1]), b = Math.min(max || 1e9, +(m[2] || m[1]));
  return a <= b ? { from: a, to: b } : null;
}
var AI_IMG_TYPES = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'image/gif': 1 };
async function aiImageBlock(rec) {
  var type = rec.type || 'image/jpeg', buf = rec.buf;
  if (!AI_IMG_TYPES[type] || buf.byteLength > 4.5e6) {
    var small = await shrinkImage(new File([buf], rec.name || 'slika.jpg', { type: type }), 1600);
    if (!AI_IMG_TYPES[small.type]) throw { status: 0, message: t('format slike nije podržan') };
    buf = await readFile(small, false); type = small.type;
  }
  return { type: 'image', source: { type: 'base64', media_type: type, data: bufToB64(buf) } };
}
async function aiSource(x, range) {
  var blocks = [], label = x.title || t('Bez naslova');
  if (isBuiltin(x.id) || x.type === 'text') {
    blocks.push({ type: 'text', text: '<materijal naslov="' + label.replace(/"/g, "'") + '">\n' + (x.body || '') + '\n</materijal>' });
    var imgs = (x.images || []).slice(0, 5);
    for (var i = 0; i < imgs.length; i++) { var r = await fileGet(imgs[i].fileId); if (r) blocks.push(await aiImageBlock(r)); }
  } else if (x.type === 'docx') {
    var dt = docText[x.fileId] || await extractText(x);
    blocks.push({ type: 'text', text: '<materijal naslov="' + label.replace(/"/g, "'") + '">\n' + ((dt && dt.text) || '') + '\n</materijal>' });
  } else if (x.type === 'pdf') {
    var rec = await fileGet(x.fileId);
    if (!rec) throw { status: 0, message: t('Fajl nije pronađen na ovom uređaju.') };
    var pages = x.pages || 0;
    var maxPdf = aiProvider() === 'gemini' ? GEMINI_MAX_PDF : AI_MAX_PDF;
    if (range || rec.buf.byteLength > maxPdf || pages > AI_MAX_PAGES) {
      var txt = docText[x.fileId] || await extractText(x), list = (txt && txt.pages) || [];
      var rg = range || { from: 1, to: Math.min(list.length, AI_MAX_PAGES) };
      blocks.push({ type: 'text', text: '<materijal naslov="' + label.replace(/"/g, "'") + '" strane="' + rg.from + '-' + rg.to + '">\n' +
        list.slice(rg.from - 1, rg.to).map(function (p, k) { return '[strana ' + (rg.from + k) + ']\n' + p; }).join('\n\n') + '\n</materijal>' });
    } else {
      blocks.push({ type: 'document', title: label, source: { type: 'base64', media_type: 'application/pdf', data: bufToB64(rec.buf) } });
    }
  } else if (x.type === 'image') {
    var ir = await fileGet(x.fileId);
    if (!ir) throw { status: 0, message: t('Fajl nije pronađen na ovom uređaju.') };
    blocks.push(await aiImageBlock(ir));
  }
  // materijal se kešira: "Još kartica" iz istog dokumenta je mnogo jeftinije
  if (blocks.length) blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
  return blocks;
}

/* ---------- pravljenje kartica ---------- */
var AI_SYSTEM = [
  'Praviš materijal za učenje (kartice i pitanja za kviz) iz materijala koji korisnik pošalje.',
  'Pravila:',
  '- Piši na istom jeziku i istim pismom kao materijal (srpska latinica ostaje latinica, ćirilica ćirilica, engleski engleski).',
  '- Koristi samo ono što piše u materijalu. Ne izmišljaj činjenice.',
  '- Jedna kartica = jedna jasna stvar koju treba zapamtiti. Pitanje mora da se razume i bez materijala.',
  '- Odgovor je kratak: jedna do tri rečenice ili kratka lista. Odgovor se ne krije u pitanju.',
  '- Formatiranje koje aplikacija razume: **podebljano**, *kurziv*, liste sa "- " na početku reda, formule kao $formula$ (LaTeX).',
  '- Kartice sa prazninama: u polju q je jedna rečenica ili dve, a ključni pojam (najviše dva po kartici) je u {{dvostrukim vitičastim zagradama}}. Polje a je kratko dodatno objašnjenje ili prazno.',
  '- Pitanja za kviz: 3 do 5 ponuđenih odgovora, tačno jedan tačan (correct je njegov indeks od 0). Netačni odgovori su verodostojni, slične dužine kao tačan, bez "sve navedeno".',
  '- Pokrij najvažnije pojmove ravnomerno kroz ceo materijal, bez ponavljanja.',
  '- Ne ponavljaj pitanja sa spiska postojećih pitanja ako je dat.'
].join('\n');
var AI_SCHEMA = {
  type: 'object',
  properties: {
    cards: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' } }, required: ['q', 'a'], additionalProperties: false } },
    questions: { type: 'array', items: { type: 'object', properties: {
      q: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, correct: { type: 'integer' }
    }, required: ['q', 'options', 'correct'], additionalProperties: false } }
  },
  required: ['cards', 'questions'], additionalProperties: false
};
function aiTask(o) {
  var what = o.kind === 'quiz' ? 'pitanja za kviz (polje questions; cards ostavi prazno)'
    : o.kind === 'cloze' ? 'kartice sa prazninama (polje cards; questions ostavi prazno)'
    : 'kartice pitanje/odgovor (polje cards; questions ostavi prazno)';
  var lines = ['Napravi ' + what + '.'];
  lines.push(o.count ? 'Broj: tačno ' + o.count + '.' : 'Broj: koliko je potrebno da se pokriju važni pojmovi, najviše 30.');
  if (o.range) lines.push('Koristi samo strane ' + o.range.from + '–' + o.range.to + '.');
  if (o.hint) lines.push('Dodatno uputstvo korisnika: ' + o.hint);
  if (o.avoid && o.avoid.length) lines.push('Postojeća pitanja (ne ponavljaj ih):\n' + o.avoid.slice(0, 150).map(function (q) { return '- ' + q; }).join('\n'));
  return lines.join('\n');
}
// poziv: vraća { cards, questions, cost, tokens }; onProgress(n) javlja koliko je stavki napisano (Claude)
async function aiGenerate(note, o, onProgress) {
  var blocks = await aiSource(note, o.range);
  if (aiProvider() === 'gemini') {
    var g = await geminiCall({ system: AI_SYSTEM, parts: geminiParts(blocks).concat([{ text: aiTask(o) }]), json: true });
    var parsed;
    try { parsed = JSON.parse(g.text); } catch (e) { throw { tooLong: true }; }
    return aiClean(parsed, o, 0, g.tokens);
  }
  var m = aiModel(), client = await aiClient();
  var fmt = window.AnthropicSDK.jsonSchemaOutputFormat(AI_SCHEMA);
  var params = {
    model: m.id, max_tokens: 32000, system: AI_SYSTEM,
    output_config: { effort: 'medium', format: { type: fmt.type, schema: fmt.schema } },
    messages: [{ role: 'user', content: blocks.concat([{ type: 'text', text: aiTask(o) }]) }]
  };
  var stream;
  if (m.fallback) {
    // pri odbijanju (bezbednosni filter) zahtev se na serveru ponovi na preporučenom modelu
    params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default';
    stream = client.beta.messages.stream(params);
  } else stream = client.messages.stream(params);
  var acc = '';
  stream.on('text', function (d) { acc += d; if (onProgress) onProgress((acc.match(/"q"\s*:/g) || []).length); });
  var msg = await stream.finalMessage();
  var cost = aiCost(msg.usage, m); aiUsageAdd(cost);
  if (msg.stop_reason === 'refusal') throw { refusal: true };
  if (msg.stop_reason === 'max_tokens') throw { tooLong: true };
  var text = msg.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
  return aiClean(fmt.parse(text), o, cost, (msg.usage.input_tokens || 0) + (msg.usage.output_tokens || 0));
}
// odbacuje prazne kartice, praznine bez {{ }} i pitanja bez bar dva odgovora i tačnog
function aiClean(out, o, cost, tokens) {
  var cards = (out.cards || []).filter(function (c) { return c && String(c.q || '').trim(); }).map(function (c) { return { q: String(c.q).trim(), a: String(c.a || '').trim() }; });
  if (o.kind === 'cloze') cards = cards.filter(function (c) { return clozeCount(c.q) > 0; });
  var questions = (out.questions || []).map(function (q) {
    var opts = (q.options || []).map(function (x) { return String(x).trim(); }).filter(Boolean).slice(0, LETTERS.length);
    return { q: String(q.q || '').trim(), options: opts, correct: q.correct >= 0 && q.correct < opts.length ? q.correct : null };
  }).filter(function (q) { return q.q && q.options.length >= 2 && q.correct !== null; });
  return { cards: cards, questions: questions, cost: cost, tokens: tokens };
}

/* ---------- tok: prozor za izbor → pravljenje → pregled → dodavanje ---------- */
function aiNeedKey() {
  if (aiKeySource() === 'app') {
    modal({ title: t('Prijavi se za AI'), text: t('AI radi bez tvog ključa kad si prijavljen. Može i sa tvojim ključem, u Podešavanja → AI asistent.'),
      buttons: [{ label: t('Prijavi se'), kind: 'primary', onClick: function () { ui.screen = 'settings'; render(); setTimeout(function () { var el = document.getElementById('syncEmail'); if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); } }, 50); } },
        { label: t('Upiši svoj ključ'), kind: 'plain', onClick: function () { aiSetSource('own'); ui.screen = 'settings'; render(); setTimeout(function () { var el = document.getElementById('aiSourceSeg'); if (el) el.scrollIntoView({ block: 'center' }); }, 50); } },
        { label: t('Otkaži'), kind: 'cancel' }] });
    return;
  }
  modal({ title: t('AI asistent nije podešen'), text: t('Izaberi Claude ili Gemini i upiši ključ u Podešavanja → AI asistent. Ključ ostaje samo na ovom uređaju.'),
    buttons: [{ label: t('Otvori podešavanja'), kind: 'primary', onClick: function () { ui.screen = 'settings'; render(); setTimeout(function () { var el = document.getElementById('aiKeyInput'); if (el) el.scrollIntoView({ block: 'center' }); }, 50); } },
      { label: t('Otkaži'), kind: 'cancel' }] });
}
// target: { kind: 'deck'|'quiz', id } kad se kreće iz izmene špila ili kviza
function aiStart(noteId, target) {
  if (!aiReady()) { aiNeedKey(); return; }
  var x = noteById(noteId); if (!x) return;
  var kinds = [{ value: 'qa', label: t('Kartice: pitanje i odgovor') }, { value: 'cloze', label: t('Kartice sa prazninama') }, { value: 'quiz', label: t('Pitanja za kviz') }];
  var fields = [
    { id: 'kind', label: t('Šta da napravi'), value: target && target.kind === 'quiz' ? 'quiz' : 'qa', options: kinds },
    { id: 'count', label: t('Koliko'), value: '', options: [{ value: '', label: t('Koliko treba (do 30)') }, { value: '5', label: '5' }, { value: '10', label: '10' }, { value: '20', label: '20' }, { value: '40', label: '40' }] }
  ];
  if (x.type === 'pdf') fields.push({ id: 'range', label: t('Strane (prazno = ceo dokument)'), value: '', placeholder: x.pages ? '1–' + x.pages : t('npr. 1-10') });
  fields.push({ id: 'hint', label: t('Dodatno uputstvo (nije obavezno)'), value: '', placeholder: t('npr. samo definicije, teže pitanja…'), multiline: true, rows: 2 });
  var a = sync.ai;
  var info = aiKeySource() === 'app'
    ? (a && a.limit != null ? t('AI aplikacije (Gemini). Danas: {u} / {l} poziva.', { u: a.used || 0, l: a.limit }) : t('AI aplikacije (Gemini).')) +
      ' ' + t('Google sme da koristi poslat materijal za unapređenje modela.')
    : aiProvider() === 'gemini'
    ? t('Model: {m} (Gemini). Besplatni nivo ima dnevno ograničenje, a Google sme da koristi poslat materijal za unapređenje modela.', { m: geminiModel() })
    : t('Model: {m}. Plaća se sa tvog Anthropic naloga; cena se vidi posle pravljenja.', { m: aiModel().name });
  modal({
    title: t('Napravi kartice iz „{n}”', { n: x.title || t('Bez naslova') }),
    text: info,
    fields: fields,
    buttons: [{ label: t('Napravi'), kind: 'primary', onClick: function (v) {
      var range = null;
      if (v.range && v.range.trim()) { range = parseRange(v.range, x.pages); if (!range) { var r = document.getElementById('mf-range'); if (r) r.focus(); return false; } }
      setTimeout(function () { aiRun(x.id, { kind: v.kind, count: v.count ? +v.count : 0, range: range, hint: (v.hint || '').trim().slice(0, 500) }, target); }, 0);
    } }, { label: t('Otkaži'), kind: 'cancel' }]
  });
}
// pitanja koja već postoje na cilju, da se ne ponove
function aiAvoid(o, target, prev) {
  var list = [];
  if (target && target.kind === 'deck') { var d = data.decks.find(function (k) { return k.id === target.id; }); if (d) list = d.cards.map(function (c) { return plainText(c.q); }); }
  if (target && target.kind === 'quiz') { var z = data.quizzes.find(function (k) { return k.id === target.id; }); if (z) list = z.questions.map(function (q) { return plainText(q.q); }); }
  if (prev) list = list.concat(prev.cards.map(function (c) { return plainText(c.q); }), prev.questions.map(function (q) { return plainText(q.q); }));
  return list;
}
function aiRun(noteId, o, target, prev) {
  var x = noteById(noteId); if (!x) return;
  o.avoid = aiAvoid(o, target, prev);
  var closeBusy = modal({ title: t('{ai} pravi kartice…', { ai: aiName() }), text: t('Čita materijal. Ovo traje od nekoliko sekundi do minut.'), buttons: [{ label: t('Sakrij'), kind: 'cancel' }] });
  var p = document.querySelector('.modal p');
  aiGenerate(x, o, function (n) { if (p && n) p.textContent = t('Napisano: {n}', { n: n }); }).then(function (res) {
    closeBusy();
    var items = res.cards.map(function (c) { return { q: c.q, a: c.a, on: true }; });
    var qs = res.questions.map(function (q) { return { q: q.q, options: q.options, correct: q.correct, on: true }; });
    if (prev) { items = prev.cards.concat(items); qs = prev.questions.concat(qs); }
    if (!items.length && !qs.length) { toast(t('{ai} nije napravio nijednu karticu. Probaj sa drugim uputstvom.', { ai: aiName() })); return; }
    ui.ai = { noteId: noteId, opts: o, target: target || null, cards: items, questions: qs, cost: (prev ? prev.cost : 0) + res.cost, tokens: (prev ? prev.tokens || 0 : 0) + (res.tokens || 0), provider: aiProvider(), back: ui.screen };
    ui.screen = 'aiReview'; render();
  }, function (e) {
    closeBusy();
    modal({ title: t('Kartice nisu napravljene'), text: aiErrorText(e), buttons: [{ label: t('U redu'), kind: 'cancel' }] });
  });
}

/* ---------- ekran: pregled predloga ---------- */
function viewAiReview() {
  var s = ui.ai, quizMode = s.opts.kind === 'quiz', list = quizMode ? s.questions : s.cards;
  var on = list.filter(function (x) { return x.on; }).length;
  var x = noteById(s.noteId);
  var opts = quizMode
    ? data.quizzes.map(function (z) { return { value: 'quiz:' + z.id, label: z.name || t('Bez naziva') }; }).concat([{ value: 'quiz:new', label: t('+ Novi kviz') }])
    : data.decks.map(function (d) { return { value: 'deck:' + d.id, label: d.name || t('Bez naziva') }; }).concat([{ value: 'deck:new', label: t('+ Novi špil') }]);
  var cur = s.dest || (s.target ? s.target.kind + ':' + s.target.id : opts[0].value);
  if (!opts.some(function (o) { return o.value === cur; })) cur = opts[opts.length - 1].value;
  s.dest = cur;
  var rows = list.map(function (it, i) {
    var body = quizMode
      ? '<textarea class="input" data-ai="q" data-i="' + i + '" rows="1" aria-label="' + esc(t('Pitanje')) + '">' + esc(it.q) + '</textarea>' +
        '<div class="ai-opts">' + it.options.map(function (o, k) {
          return '<div class="ai-opt' + (k === it.correct ? ' ok' : '') + '">' + (k === it.correct ? ICON.check : '<span class="opt-l">' + LETTERS[k] + '</span>') + '<span class="md">' + renderMarkup(o, { inline: true }) + '</span></div>';
        }).join('') + '</div>'
      : '<textarea class="input ed-q" data-ai="q" data-i="' + i + '" rows="1" aria-label="' + esc(t('Pitanje')) + '">' + esc(it.q) + '</textarea>' +
        '<textarea class="input" data-ai="a" data-i="' + i + '" rows="2" aria-label="' + esc(t('Odgovor')) + '">' + esc(it.a) + '</textarea>';
    return '<div class="ed-card ai-item' + (it.on ? '' : ' off') + '">' +
      '<label class="ai-check"><input type="checkbox" data-ai-on="' + i + '"' + (it.on ? ' checked' : '') + '><span>' + (quizMode ? t('Pitanje {n}', { n: i + 1 }) : t('Kartica {n}', { n: i + 1 })) + '</span></label>' +
      body + '</div>';
  }).join('');
  return '<div class="screen edit ai-review">' +
    '<div class="topbar">' + backBtn('aiCancel', t('Odbaci')) + '<span class="small-note num">' + esc(s.provider === 'gemini' ? t('Gemini · {n} tokena', { n: s.tokens || 0 }) : t('Cena: {c}', { c: fmtUsd(s.cost) })) + '</span></div>' +
    '<div class="head" style="padding-top:0"><span class="eyebrow">' + ICON.spark + ' ' + t('Predlozi iz „{n}”', { n: esc(x ? x.title || t('Bez naslova') : '') }) + '</span>' +
      '<h1>' + (quizMode ? t('Pitanja za kviz') : t('Nove kartice')) + '</h1>' +
      '<span class="sub">' + t('Proveri, izmeni ili isključi predloge pa ih dodaj.') + '</span></div>' +
    '<div class="field"><label class="label" for="aiDest">' + t('Dodaj u') + '</label><select class="input" id="aiDest">' +
      opts.map(function (o) { return '<option value="' + esc(o.value) + '"' + (o.value === cur ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') + '</select></div>' +
    '<div class="ed-list">' + rows + '</div>' +
    '<div class="row-btns even"><button class="btn" data-act="aiMore">' + ICON.spark + ' ' + t('Još predloga') + '</button>' +
    '<button class="btn primary" data-act="aiAdd"' + (on ? '' : ' disabled') + '>' + t('Dodaj izabrane ({n})', { n: on }) + '</button></div>' +
    '</div>';
}
function aiAdd() {
  var s = ui.ai; if (!s) return;
  var quizMode = s.opts.kind === 'quiz', list = (quizMode ? s.questions : s.cards).filter(function (x) { return x.on && x.q.trim(); });
  if (!list.length) return;
  var p = s.dest.split(':'), x = noteById(s.noteId), name = (x && x.title) || (quizMode ? t('Novi kviz') : t('Novi špil'));
  if (quizMode) {
    var z = p[1] === 'new' ? null : data.quizzes.find(function (k) { return k.id === p[1]; });
    if (!z) { z = { id: uid(), name: name, tag: t('Napravio AI'), questions: [], known: {} }; data.quizzes.push(z); }
    var qs = nextNo(z.questions);
    list.forEach(function (q, k) { z.questions.push({ id: uid(), n: String(qs + k + 1), q: q.q, options: q.options.slice(), correct: q.correct }); });
    save(); ui.ai = null; ui.quizId = z.id; ui.screen = 'quiz'; render();
    toast(t('Dodato: {n} {w}', { n: list.length, w: pw(list.length, 'pitanje') }));
  } else {
    var d = p[1] === 'new' ? null : data.decks.find(function (k) { return k.id === p[1]; });
    if (!d) { d = { id: uid(), name: name, tag: t('Napravio AI'), cards: [], known: {}, lang: 'sr-RS' }; data.decks.push(d); }
    var start = nextNo(d.cards), cloze = s.opts.kind === 'cloze';
    list.forEach(function (c, k) {
      var card = { id: uid(), n: String(start + k + 1), q: c.q, a: c.a };
      if (cloze && clozeCount(c.q)) card.type = 'cloze';
      d.cards.push(card);
    });
    save(); ui.ai = null; ui.deckId = d.id; ui.screen = 'deck'; render();
    toast(t('Dodato: {n} {w}', { n: list.length, w: pw(list.length, 'kartica') }));
  }
}

/* ---------- Objasni mi (poleđina kartice i odgovoreno pitanje u kvizu) ----------
   Objašnjenje se čuva u ui.explain (po kartici ili pitanju), pa ostaje i kad se ekran ponovo iscrta;
   dok stiže, menja se samo okvir, da se kartica ne okreće ponovo. */
function explainKey() {
  if (ui.screen === 'quizPlay' && ui.qz) { var z = quiz(); return z ? 'q:' + z.id + ':' + ui.qz.order[ui.qz.i] : ''; }
  return ui.screen === 'cards' ? 'c:' + ui.order[ui.i] : '';
}
function explainHtml() {
  var x = ui.explain;
  if (!x || x.key !== explainKey()) return '';
  if (x.err) return '<div class="explain" id="explainBox"><span class="label">' + esc(x.err) + '</span></div>';
  return '<div class="explain" id="explainBox"><span class="label">' + ICON.spark + ' ' +
    (x.busy ? t('{ai} objašnjava…', { ai: aiName() }) : t('Objašnjenje')) + '</span>' +
    '<div class="md">' + (x.text ? renderMarkup(x.text) : '') + '</div></div>';
}
// osveži samo okvir sa objašnjenjem (ako je ta kartica ili pitanje još na ekranu)
function explainPaint(x, scroll) {
  if (ui.explain !== x || x.key !== explainKey()) return;
  var html = explainHtml(), box = document.getElementById('explainBox');
  if (!box) {
    var host = document.querySelector(ui.screen === 'quizPlay' ? '.quiz-body' : '.answer-scroll'); if (!host) return;
    host.insertAdjacentHTML('beforeend', html);
    box = document.getElementById('explainBox');
  } else {
    box.outerHTML = html;
    box = document.getElementById('explainBox');
  }
  if (!box) return;
  if (!x.busy && box.querySelector('.math')) renderMath(box);
  if (scroll) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function explainPrompt() {
  var system = 'Objašnjavaš učeniku odgovor, jednostavno i tačno, na istom jeziku i pismu kao pitanje. Najviše 5 kratkih rečenica, po potrebi primer. Formatiranje: **podebljano**, liste sa "- ", formule $...$. Bez uvoda i bez ponavljanja pitanja.';
  if (ui.screen === 'quizPlay') {
    var z = quiz(), s = ui.qz, q = qById(z, s.order[s.i]);
    var opts = optionList(q), right = opts.find(function (o) { return o.i === q.correct; }), mine = opts.find(function (o) { return o.i === s.picked; });
    var list = opts.map(function (o, k) { return LETTERS[k] + ') ' + plainText(o.t); }).join('\n');
    var ask = 'Pitanje iz kviza: ' + plainText(q.q) + '\nPonuđeni odgovori:\n' + list +
      '\nTačan odgovor: ' + (right ? plainText(right.t) : '') +
      (mine && mine !== right ? '\nUčenik je izabrao: ' + plainText(mine.t) + '\n\nObjasni zašto je tačan odgovor tačan i zašto izabrani nije.' : '\n\nObjasni zašto je to tačan odgovor.');
    return { system: system, ask: ask };
  }
  var it = itemOf(ui.order[ui.i]); if (!it) return null;
  var sd = studySides(it);
  var cq = sd.cloze ? plainText(clozeText(it.card.q, it.n, false)) : plainText(it.card.q);
  var ca = sd.cloze ? plainText(clozeText(it.card.q, it.n, true)) + (it.card.a ? '\n' + plainText(it.card.a) : '') : plainText(it.card.a || '');
  return { system: system, ask: 'Pitanje: ' + cq + '\nOdgovor sa kartice: ' + (ca || '(nema tekstualnog odgovora)') + '\n\nObjasni zašto je to tako.' };
}
async function aiExplain() {
  if (!aiReady()) { aiNeedKey(); return; }
  var key = explainKey(); if (!key) return;
  if (ui.explain && ui.explain.key === key && (ui.explain.busy || ui.explain.text)) { explainPaint(ui.explain, true); return; }
  var pr = explainPrompt(); if (!pr) return;
  var x = ui.explain = { key: key, busy: true, text: '', err: '' };
  explainPaint(x, true);
  try {
    if (aiProvider() === 'gemini') {
      // Gemini razmišlja pre odgovora i to troši isti limit tokena, pa je limit velik, a prekinut odgovor se ipak prikaže
      var g = await geminiCall({ system: pr.system, parts: [{ text: pr.ask }], maxTokens: 16384, partial: true });
      if (!g.text.trim()) throw { refusal: true };
      x.text = g.text;
    } else {
      var m = aiModel(), client = await aiClient();
      var params = { model: m.id, max_tokens: 2000, output_config: { effort: 'low' }, system: pr.system, messages: [{ role: 'user', content: pr.ask }] };
      var stream;
      if (m.fallback) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; stream = client.beta.messages.stream(params); }
      else stream = client.messages.stream(params);
      stream.on('text', function (d) { x.text += d; explainPaint(x); });
      var msg = await stream.finalMessage();
      aiUsageAdd(aiCost(msg.usage, m));
      if (msg.stop_reason === 'refusal') throw { refusal: true };
    }
  } catch (e) {
    x.err = aiErrorText(e);
  }
  x.busy = false;
  explainPaint(x, true);
}

/* ---------- podešavanja ---------- */
function aiSettingsSection() {
  var src = aiKeySource(), gem = aiProvider() === 'gemini';
  return '<div class="section"><h2>' + t('AI asistent') + '</h2>' +
    (appAiConfigured() ? '<div id="aiSourceSeg">' + seg('setAiSource', [['app', t('Ključ aplikacije')], ['own', t('Moj ključ')]], src) + '</div>' : '') +
    (src === 'app' ? appAiSettings()
      : seg('setProvider', [['claude', 'Claude'], ['gemini', 'Gemini']], aiProvider()) + (gem ? geminiSettings() : claudeSettings())) +
    '</div>';
}
// ključ aplikacije: stanje naloga i današnja potrošnja
function appAiSettings() {
  var note = '<p class="small-note">' + t('AI pravi kartice i pitanja iz tvojih beleški i objašnjava odgovore, bez tvog ključa (Gemini preko servera aplikacije). Google sme da koristi poslat materijal za unapređenje svojih modela, pa ne šalji ništa privatno.') + '</p>';
  if (!sync.user) {
    return note + '<p class="small-note">' + t('Za ovo se prijavi na nalog, gore u odeljku Nalog i sinhronizacija.') + '</p>';
  }
  var a = sync.ai, line;
  if (!a) line = t('Učitavam stanje naloga…');
  else if (a.blocked) line = t('Tvoj nalog je blokiran za AI aplikacije. Možeš da koristiš svoj ključ.');
  else if (!a.on) line = t('Besplatan AI je trenutno isključen. Možeš da koristiš svoj ključ.');
  else if (a.limit == null) line = t('Danas: {u} poziva (administrator, bez limita).', { u: a.used || 0 });
  else line = t('Danas: {u} / {l} poziva. Limit se obnavlja svakog dana.', { u: a.used || 0, l: a.limit });
  return note + '<p class="small-note num">' + line + '</p>';
}
function keyRow(key) {
  return '<div class="row-between"><span class="small-note">' + t('Ključ: {k}', { k: esc(key.slice(0, 8) + '…' + key.slice(-4)) }) + '</span>' +
    '<span class="foot-actions"><button class="link" data-act="aiCheckKey">' + t('Proveri') + '</button><button class="link danger" data-act="aiDelKey">' + t('Ukloni') + '</button></span></div>';
}
function geminiSettings() {
  var key = geminiKey(), u = aiUsageGet(), list = geminiModels(), cur = geminiModel();
  if (!key) {
    return '<p class="small-note">' + t('Gemini pravi kartice i pitanja iz tvojih beleški, PDF-ova i slika, i objašnjava odgovore. Ključ dobijaš besplatno na aistudio.google.com → Get API key.') + '</p>' +
      '<input class="input" id="geminiKeyInput" type="password" placeholder="AIza… / AQ.…" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="' + esc(t('Gemini API ključ')) + '">' +
      '<button class="btn small" data-act="aiSaveKey">' + t('Sačuvaj ključ') + '</button>' +
      '<p class="small-note">' + t('Ključ ostaje samo na ovom uređaju: ne ide u rezervnu kopiju ni u sinhronizaciju.') + '</p>';
  }
  return keyRow(key) +
    '<div class="field"><label class="label" for="geminiModelSel">' + t('Model') + '</label>' +
      (list.length ? '<select class="input" id="geminiModelSel" data-setting="geminiModel">' + list.map(function (m) {
        return '<option value="' + esc(m.id) + '"' + (m.id === cur ? ' selected' : '') + '>' + esc(m.name + ' (' + m.id + ')') + '</option>';
      }).join('') + '</select>' : '<p class="small-note">' + t('Klikni Proveri da se učita spisak modela.') + '</p>') +
      '<p class="small-note">' + t('Besplatni nivo ima ograničen broj zahteva po minutu i danu, a Google sme da koristi poslat materijal za unapređenje svojih modela.') + '</p></div>' +
    '<p class="small-note num">' + t('Ovog meseca na ovom uređaju: {n} poziva, {k} tokena', { n: u.calls, k: u.tokens || 0 }) + '</p>';
}
function claudeSettings() {
  var key = aiKey(), u = aiUsageGet();
  var models = AI_MODELS.map(function (m) {
    return { value: m.id, label: m.name + ' · $' + m.inp + ' / $' + m.out };
  });
  return (key
      ? keyRow(key) +
        '<div class="field"><label class="label" for="aiModelSel">' + t('Model') + '</label><select class="input" id="aiModelSel" data-setting="aiModel">' +
          models.map(function (o) { return '<option value="' + o.value + '"' + (o.value === data.settings.aiModel ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') +
        '</select><p class="small-note">' + t('Cena je u dolarima po milion ulaznih / izlaznih tokena. PDF od 20 strana sa Opus 5.5 košta otprilike 10–30 centi, sa Haiku 5.5 manje od jednog centa.') + '</p></div>' +
        '<p class="small-note num">' + t('Ovog meseca na ovom uređaju: {c} ({n} poziva)', { c: fmtUsd(u.usd), n: u.calls }) + '</p>'
      : '<p class="small-note">' + t('Claude može da pravi kartice i pitanja iz tvojih beleški, PDF-ova i slika, i da objašnjava odgovore. Treba ti Anthropic API ključ (console.anthropic.com); plaća se po korišćenju, sa tvog naloga.') + '</p>' +
        '<input class="input" id="aiKeyInput" type="password" placeholder="sk-ant-…" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="' + esc(t('Anthropic API ključ')) + '">' +
        '<button class="btn small" data-act="aiSaveKey">' + t('Sačuvaj ključ') + '</button>' +
        '<p class="small-note">' + t('Ključ ostaje samo na ovom uređaju: ne ide u rezervnu kopiju ni u sinhronizaciju.') + '</p>');
}
function aiSaveKey() {
  var gem = aiProvider() === 'gemini', el = document.getElementById(gem ? 'geminiKeyInput' : 'aiKeyInput'), v = el ? el.value.trim() : '';
  // Gemini ključevi imaju više oblika (AIza…, AQ.…), pa se ovde proverava samo da je ključ bez razmaka; ispravnost proverava Google
  if (gem ? !/^\S{20,}$/.test(v) : !/^sk-ant-/.test(v)) { toast(gem ? t('Ključ nije potpun. Kopiraj ga ceo iz AI Studija.') : t('Ključ treba da počinje sa sk-ant-')); if (el) el.focus(); return; }
  try { localStorage.setItem(gem ? GEMINI_KEY : AI_KEY, v); } catch (e) { toast(t('Ključ nije sačuvan.')); return; }
  render(true); aiCheckKey();
}
// Claude: podaci o modelu (bez troška); Gemini: spisak modela, koji se i pamti za izbor
function aiCheckKey() {
  toast(t('Proveravam ključ…'));
  var p = aiProvider() === 'gemini'
    ? geminiLoadModels().then(function (list) { if (!list.length) throw { gemini: true, status: 404, message: '' }; })
    : aiClient().then(function (c) { return c.models.retrieve(aiModel().id); });
  p.then(function () { toast(t('Ključ radi.')); if (ui.screen === 'settings') render(true); }, function (e) { toast(aiErrorText(e)); });
}
function aiDelKey() {
  var gem = aiProvider() === 'gemini';
  modal({ title: t('Ukloniti API ključ?'), text: t('AI asistent neće raditi dok ponovo ne upišeš ključ.'), buttons: [
    { label: t('Ukloni'), kind: 'danger', onClick: function () { try { localStorage.removeItem(gem ? GEMINI_KEY : AI_KEY); if (gem) localStorage.removeItem(GEMINI_LIST); } catch (e) {} render(true); } },
    { label: t('Otkaži'), kind: 'cancel' }] });
}
// izbor beleške kad se kreće iz izmene špila ili kviza
function aiPickNote(target) {
  if (!aiReady()) { aiNeedKey(); return; }
  var notes = BUILTIN_NOTES.concat(data.notes).filter(function (n) { return n.type !== 'image' || n.fileId; });
  if (!notes.length) { toast(t('Nemaš nijednu belešku. Dodaj belešku, PDF ili Word dokument.')); return; }
  modal({ title: t('Iz koje beleške?'), fields: [{ id: 'note', label: t('Beleška'), value: notes[0].id, options: notes.map(function (n) {
    var tag = n.type === 'pdf' ? ' (PDF)' : n.type === 'docx' ? ' (Word)' : n.type === 'image' ? ' (' + t('slika') + ')' : '';
    return { value: n.id, label: (n.title || t('Bez naslova')) + tag };
  }) }], buttons: [{ label: t('Dalje'), kind: 'primary', onClick: function (v) { setTimeout(function () { aiStart(v.note, target); }, 0); } }, { label: t('Otkaži'), kind: 'cancel' }] });
}
