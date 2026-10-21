# Predlog: Supabase Realtime umesto 60-sekundnog anketiranja

## Problem

`sync.js` (red 374) na svakih 60 s poziva `syncNow()` dok je korisnik prijavljen i tab vidljiv.
Svaki ciklus uradi `pullAll()` — GET na `/rest/v1/items?...&server_ts=gt.<lastPull>`:

- ~90 %+ odgovora je prazno (ništa novo) — čisti gubitak: 1440+ zahteva dnevno po uređaju,
  samo da se sazna da se ništa ne dešava.
- Latencija je loša: izmena sa drugog uređaja stiže do 60 s kasnije, mada je podatak na serveru
  odmah.
- Dvostruki identični zahtevi (interval + `visibilitychange` u istom prozoru) su vidljivi u
  DevTools mreži i zbunjuju (prianalizi 2026-10-21).

## Predlog rešenja

Realtime ne prenosi podatke — samo **javlja da je nešto novo**, pa se odmah pokrene postojeći
`syncNow()`. Logika povlačenja (`pullAll`, vodeni žig `lastPull`, straničenje, primena redova,
preklapanje od 5 s) ostaje netaknuta i dalje je jedini izvor istine. Realtime je samo okidač.

### Šta se menja u `sync.js`

1. **Otkazivanje brzog intervala.** `setInterval(syncNow, 60000)` → sporija rezerva, npr. 5–10 min
   (hvata propuštene događaje posle prekida veze, osvežavanja tokena i sl.).
2. **Realtime pretplata** (posle uspešne prijave, kad postoji `sync.user`):

   ```js
   function syncRealtime(c) {
     if (sync.as || sync.ch) return;                    // admin režim ostaje na anketiranju
     sync.ch = c.channel('items-sync')
       .on('postgres_changes',
           { event: '*', schema: 'public', table: 'items', filter: 'user_id=eq.' + sync.user.id },
           function () { clearTimeout(sync.rt); sync.rt = setTimeout(syncNow, 300); })
       .subscribe();
   }
   // pri odjavi (signOut, postojeća sincronizacija čišćenja): c.removeChannel(sync.ch)
   ```

   - `filter: user_id=eq.<uid>` — tabela `items` već ima kolonu `user_id` (schema.sql), pa server
     šalje samo redove tog korisnika. Payload se ignoriše; koristi se samo kao signal.
   - Debounce 300 ms: jedan push od 500 redova proizvede stotine događaja; svi se skupe u jedan
     `syncNow` (on je ionako single-flight preko `sync.running` / `sync.again`).
   - Sopstveni upisi takođe proizvode događaje → dolazi do jednog dodatnog `pullAll` koji vraća
     sopstvene redove; primena ih preskoči (otisak `sync.shadow` se poklapa) i žig `lastPull`
     napreduje. Bezopasno, dešava se jednom po sopstvenoj izmeni.

### Šta se menja u `supabase/schema.sql`

Dodati jedan red (i u README za postojeće projekte):

```sql
alter publication supabase_realtime add table public.items;
```

Bez toga Realtime ne dostavlja ništa za tabelu `items`.

### Šta se NE menja

- `syncRun`: push (`sync_push`), pull (`pullAll`), primena, žig `lastPull`, fajlovi (`syncFiles`).
- Okidači koji ostaju: 3 s posle svakog čuvanja (`syncAfterSave`), `online` događaj,
  `visibilitychange` → kad se korisnik vrati na tab, dobija sveže odmah, bez čekanja.
- Admin režim (`sync.as`, `admin_pull`): ostaje na anketiranju. Realtime `filter` radi po koloni
  `user_id`, a admin radi sa podacima *drugog* korisnika (nema jednostavan filter bez dodatne
  infrastrukture); admin sesije su retke i kratke pa spor interval ni tu ne smeta.

## Rizici i ograničenja

| Rizik | Postupak |
|---|---|
| Propušten događaj (prekid WS-a, throttle servera) | rezervni spor interval i dalje povlači; ostali okidači (`online`, `visibilitychange`) ne zavise od WS-a |
| Da li Realtime poštuje RLS | `items` ima RLS „samo svoje“; pretplata se pravi sa JWT-om prijavljenog korisnika, a `filter` po `user_id` je dodatna zaštita. Pre puštanja proveriti na stvarnom projektu da drugi korisnik ne dobija tuđe događaje. |
| Osvežavanje tokena | supabase-js sam poziva `realtime.setAuth()` pri osvežavanju sesije; proveriti verziju u `vendor/supabase.min.js` (po potrebi izbaciti noviju verziju iz vendor-a). |
| Limite projekta | Realtime ima ograničenje istovremenih veza po projektu; aplikacija drži 1 vezu po uređaju. |
| PWA/offline | kad nema veze, WS se ne otvara; ništa ne pada — spor interval, `online` i `visibilitychange` pokrivaju povratak. |

## Procena

- `sync.js`: ~25–35 redova (pretplata, debounce, odjava, sporiji interval), 1 SQL red u `schema.sql`.
- Testovi (`tests/run.js`): debounce okidač i da pretplata ne menja `pullAll`/`lastPull` logiku
  (lažni `channel()` koji beleži pozive).
- Verifikacija: dva uređaja — izmena sa drugog stiže <1 s (mesto do 60 s), u DevTools nestaje
  periodični GET; sa ~1440 zahteva/dan na jednu WS vezu + retke pull-ove.

## Alternativa (zašto ne)

- **Realtime broadcast iz DB triggera** (`pg_notify` → edge function → broadcast): manji payload,
  ali traži dodatni DB trigger i infrastrukturu, a `postgres_changes` već rešava posao.
- **Duži interval bez Realtime-a** (npr. 5 min): najjednostavnije, ali latencija ostaje loša za
  scenario „drugi uređaj mi piše“.
