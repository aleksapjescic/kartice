# Kartice — podešavanje naloga i sinhronizacije (Supabase)

Bez ovoga aplikacija radi kao i ranije, samo na uređaju. Sa ovim se ista e-mail adresa prijavljuje na telefonu i računaru, i sve se sinhronizuje samo.

## 1. Projekat (jednom)

1. Na [supabase.com](https://supabase.com) napravi besplatan nalog i projekat (region: Frankfurt).
2. **SQL Editor** → nalepi ceo `schema.sql` → **Run**. Fajl pravi:
   - tabelu `items`, u kojoj svako vidi samo svoje redove;
   - funkciju `sync_push`;
   - privatni bucket `files`;
   - tabelu `push_subs` za podsetnike.
3. **Authentication → Email Templates → Magic Link**: u poruku dodaj `{{ .Token }}` (na primer „Tvoj kod je {{ .Token }}”). Aplikacija traži kod, a ne link, jer link na iPhone-u otvara Safari, a ne aplikaciju.
4. **Settings → API**: kopiraj *Project URL* i *anon public* ključ u `config.js` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`). Oba su javna: pristup podacima štite pravila iz `schema.sql`.

Ograničenja besplatnog plana:
- 500 MB baze i 1 GB fajlova;
- ugrađeni e-mail šalje nekoliko poruka na sat;
- projekat se pauzira posle 7 dana bez ikakvog korišćenja i ponovo se uključuje jednim klikom.

## 2. Podsetnici (nije obavezno)

Potreban je [Supabase CLI](https://supabase.com/docs/guides/cli) i prijava: `supabase login`.

```bash
npx web-push generate-vapid-keys
```

Javni ključ ide u `config.js` (`VAPID_PUBLIC_KEY`). Oba ključa, tajna za cron i adresa za kontakt idu u tajne projekta:

```bash
supabase secrets set --project-ref <PROJEKAT> VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_CONTACT=ti@primer.com CRON_SECRET=<nasumičan tekst>
```

```bash
supabase functions deploy reminders --project-ref <PROJEKAT> --no-verify-jwt
```

Na kraju u `cron.sql` upiši projekat i `CRON_SECRET`, pa ga pokreni u SQL Editoru. Funkcija tada radi svakih 15 minuta i šalje obaveštenje samo ako tog dana ima kartica za ponavljanje.

Na iPhone-u obaveštenja rade samo kad je aplikacija dodata na početni ekran (iOS 16.4 i noviji).
