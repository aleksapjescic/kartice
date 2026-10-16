# Kartice

Aplikacija za učenje sa karticama i beleškama. Radi u pregledaču, a na telefonu se instalira kao aplikacija (PWA) i radi bez interneta.

Adresa: https://aleksapjescic.github.io/kartice/

## Šta ume

- špilovi kartica sa praćenjem naučenog, učenje po redu ili nasumično, prevlačenje na telefonu
- beleške: tekstualne, PDF (listanje stranica kao u knjizi) i Word .docx (u bojama izabrane teme)
- folderi za beleške, premeštanje beleški između foldera
- podešavanja: tema, font, veličina teksta, jezik (latinica, ćirilica, engleski), smanjene animacije, tamne PDF stranice
- rezervna kopija svih podataka u jedan .json fajl i vraćanje iz nje

## Fajlovi

| Fajl | Čemu služi |
|---|---|
| `index.html` | okvir stranice |
| `styles.css` | izgled |
| `app.js` | logika aplikacije |
| `i18n.js` | jezici: natpisi, ćirilica, engleski prevod |
| `data.js` | početni špil i beleške iz materijala |
| `vendor/` | pdf.js (PDF), mammoth (Word), StPageFlip (listanje stranica) |
| `sw.js` | rad bez interneta |
| `version.json` | broj verzije za automatsko ažuriranje |
| `manifest.json`, ikonice | ime i ikonica na početnom ekranu |

PDF i Word fajlovi čuvaju se u IndexedDB na uređaju, ostalo u localStorage.

## Objavljivanje nove verzije

Broj verzije mora da bude isti na tri mesta:

1. `APP_VERSION` na vrhu `app.js`
2. `version.json`
3. `?v=` parametri u `index.html`

Posle objavljivanja aplikacija na telefonu sama preuzme novu verziju kad se otvori dok ima internet.

## Instalacija na iPhone

Otvori adresu u **Chromu** (u Safariju iOS 26 ne prikazuje aplikaciju do dna ekrana), pa Share → **Add to Home Screen**.
Podaci se čuvaju posebno za svaku instaliranu ikonicu; za prenos koristi rezervnu kopiju iz podešavanja.
