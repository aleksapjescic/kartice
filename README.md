# Kartice

Aplikacija za učenje sa karticama i beleškama. Radi u pregledaču, a na telefonu se instalira kao aplikacija (PWA) i radi bez interneta.

Adresa: https://aleksapjescic.github.io/kartice/

## Šta ume

- **ponavljanje po rasporedu (FSRS)**: ocene Ponovo / Teško / Dobro / Lako, „Uči danas” iz svih špilova, dnevna granica novih kartica i ponavljanja
- slobodno učenje: sve ili samo nenaučene, po redu ili nasumično, prevlačenje na telefonu, kucanje odgovora
- **statistika**: dani zaredom, dnevni cilj, kalendar učenja, odgovori po danima, prognoza ponavljanja, najteže kartice, značke
- **formatiranje** u karticama, kvizovima i beleškama (podebljano, kurziv, označeno, liste, formule), kartice sa prazninama, čitanje naglas
- **AI asistent**: kartice i pitanja za kviz iz beleški, PDF-a, Word-a i slika, „Objasni mi” na kartici; radi sa tvojim ključem (Claude ili Gemini) ili, za prijavljene, sa ključem aplikacije uz dnevni limit
- **nalog i sinhronizacija** (Supabase): prijava Google-om ili kodom na e-mail, isti nalog na telefonu i računaru; dnevni podsetnik; **admin panel** za korisnike, limite i ključ aplikacije (vidi `supabase/README.md`)
- slike uz pitanje i odgovor, učenje obrnuto (odgovor → pitanje), „Poništi” poslednji odgovor, pretraga kartica
- kvizovi sa ponuđenim odgovorima: unos pitanja ili uvoz iz teksta, praćenje naučenog, ponavljanje netačnih i spisak grešaka
- beleške: tekstualne, PDF (listanje kao u knjizi ili skrolovanje, zumiranje u oba režima) i Word .docx (u bojama izabrane teme)
- pretraga beleški pretražuje i tekst u PDF i Word dokumentima; pogodak u PDF-u otvara pravu stranu
- kartica od označenog teksta u belešci
- folderi za beleške, premeštanje beleški između foldera
- podešavanja: tema, font, veličina teksta, jezik (latinica, ćirilica, engleski), smanjene animacije, tamne PDF stranice
- rezervna kopija svih podataka u jedan .json fajl i vraćanje iz nje

## Fajlovi

| Fajl | Čemu služi |
|---|---|
| `index.html` | okvir stranice |
| `styles.css` | izgled |
| `app.js` | ekrani i akcije |
| `store.js` | čuvanje podataka u IndexedDB i migracija na novu verziju |
| `srs.js` | raspored ponavljanja (FSRS) i red za danas |
| `stats.js` | statistika, dani zaredom, značke, ekran Statistika |
| `markup.js` | formatiranje teksta, formule, praznine, čitanje naglas |
| `ai.js` | AI asistent (Claude ili Gemini, tvoj ključ ili ključ aplikacije) |
| `sync.js`, `config.js` | nalog (Google ili e-mail kod), sinhronizacija i podsetnici (Supabase) |
| `admin.js` | admin panel: korisnici, limiti, ključ aplikacije |
| `supabase/` | šema baze, funkcije za podsetnike i AI (`functions/ai`) i uputstvo za podešavanje |
| `tests/run.js` | testovi bez pregledača: `node tests/run.js` |
| `i18n.js` | jezici: natpisi, ćirilica, engleski prevod |
| `data.js` | početni špil i beleške iz materijala |
| `vendor/` | pdf.js (PDF), mammoth (Word), StPageFlip (listanje stranica), ts-fsrs (raspored), KaTeX (formule), Anthropic SDK, supabase-js |
| `sw.js` | rad bez interneta |
| `version.json` | broj verzije za automatsko ažuriranje |
| `manifest.json`, ikonice | ime i ikonica na početnom ekranu |

Svi podaci i fajlovi čuvaju se u IndexedDB na uređaju. Do verzije 12 podaci su bili u localStorage; verzija 13 ih pri prvom pokretanju prenese i 30 dana čuva kopiju starog stanja (Podešavanja → Podaci).

`vendor/anthropic.min.js` je zvanični `@anthropic-ai/sdk` spakovan za pregledač:

```bash
npx esbuild entry.mjs --bundle --format=iife --global-name=AnthropicSDK --platform=browser --target=es2020 --minify
```

Ulazni fajl `entry.mjs` izvozi `Anthropic` i `jsonSchemaOutputFormat`.

## Objavljivanje nove verzije

Broj verzije mora da bude isti na tri mesta:

1. `APP_VERSION` na vrhu `app.js`
2. `version.json`
3. `?v=` parametri u `index.html`

Posle objavljivanja aplikacija na telefonu sama preuzme novu verziju kad se otvori dok ima internet.

## Instalacija na iPhone

Otvori adresu u **Chromu** (u Safariju iOS 26 ne prikazuje aplikaciju do dna ekrana), pa Share → **Add to Home Screen**.
Podaci se čuvaju posebno za svaku instaliranu ikonicu. Za prenos koristi nalog (Podešavanja → Nalog i sinhronizacija) ili rezervnu kopiju.
