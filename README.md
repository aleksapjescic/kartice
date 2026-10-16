# Kartice

Aplikacija za učenje sa karticama. Radi u pregledaču, a na telefonu se instalira kao aplikacija (PWA) i radi bez interneta.

## Fajlovi

| Fajl | Čemu služi |
|---|---|
| `index.html` | cela aplikacija |
| `manifest.json` | ime, ikonica i otvaranje preko celog ekrana |
| `sw.js` | rad bez interneta |
| `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | ikonice |

## Postavljanje na GitHub Pages (jednom)

1. Na github.com klikni **+** → **New repository**.
2. Ime: `kartice`. Izaberi **Public**. Klikni **Create repository**.
3. Klikni **uploading an existing file**. Prevuci svih 7 fajlova iz foldera (fajlove, ne ceo folder). Klikni **Commit changes**.
4. U repozitorijumu idi na **Settings** → **Pages**.
5. Pod **Branch** izaberi `main` i `/ (root)`, pa **Save**.
6. Sačekaj 1–2 minuta i osveži stranicu. Gore će pisati adresa:
   `https://TVOJE-IME.github.io/kartice/`

## Instalacija na iPhone

1. Otvori tu adresu u **Safariju**.
2. Dodirni dugme **Share** (kvadrat sa strelicom nagore).
3. Izaberi **Add to Home Screen** (Dodaj na početni ekran), pa **Add**.
4. Otvaraj aplikaciju samo preko ikonice. Napredak iz Safarija i napredak iz ikonice se na iPhone-u čuvaju odvojeno.

## Ažuriranje

1. U repozitorijumu klikni **Add file** → **Upload files** i prevuci novi `index.html`. Klikni **Commit changes**.
2. Posle 1–2 minuta otvori aplikaciju na telefonu dok imaš internet. Nova verzija se učita sama.

Kartice i napredak ostaju sačuvani posle ažuriranja. Adresa repozitorijuma ne sme da se menja.
