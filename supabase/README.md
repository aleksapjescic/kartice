# Kartice — podešavanje naloga i sinhronizacije (Supabase)

Bez ovoga aplikacija radi kao i ranije, samo na uređaju. Sa ovim se isti Google nalog prijavljuje na telefonu i računaru, i sve se sinhronizuje samo.

## 1. Projekat (jednom)

1. Na [supabase.com](https://supabase.com) napravi besplatan nalog i projekat (region: Frankfurt).
2. **SQL Editor** → nalepi ceo `schema.sql` → **Run**. Fajl pravi:
   - tabelu `items`, u kojoj svako vidi samo svoje redove;
   - funkciju `sync_push`;
   - privatni bucket `files`;
   - tabelu `push_subs` za podsetnike;
   - profile, potrošnju AI-ja i podešavanja za admin panel (`profiles`, `ai_usage`, `app_config`).
3. **Authentication → Sign In / Providers → Email**: isključi. Prijava je samo preko Google-a (odeljak 2).
4. **Settings → API**: kopiraj *Project URL* i *anon public* ključ u `config.js` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`). Oba su javna: pristup podacima štite pravila iz `schema.sql`.

Ograničenja besplatnog plana:
- 500 MB baze i 1 GB fajlova;
- projekat se pauzira posle 7 dana bez ikakvog korišćenja i ponovo se uključuje jednim klikom.

## 2. Prijava Google-om

1. U [Google Cloud Console](https://console.cloud.google.com) napravi projekat (ili izaberi postojeći).
2. **APIs & Services → OAuth consent screen**: tip *External*, upiši ime aplikacije („Kartice”) i svoj e-mail. Zatim **Publish app**, da mogu da se prijave svi, a ne samo test korisnici.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**;
   - Authorized redirect URIs: `https://<PROJEKAT>.supabase.co/auth/v1/callback` (tačna adresa piše u Supabase → Authentication → Providers → Google).
4. Kopiraj *Client ID* i *Client secret* u Supabase → **Authentication → Providers → Google** i uključi ga.
5. Supabase → **Authentication → URL Configuration**:
   - Site URL: `https://aleksapjescic.github.io/kartice/`;
   - Redirect URLs: dodaj `https://aleksapjescic.github.io/kartice/` i `http://localhost:8767/` (za probu na računaru).

## 3. AI bez ključa korisnika (tvoj Gemini ključ)

Korisnici koji nemaju svoj ključ troše tvoj, preko Edge Function `ai`. Ključ ostaje samo na serveru. Funkcija proverava ko zove, da li je blokiran i dnevni limit, pa tek onda šalje zahtev Google-u.

Potreban je [Supabase CLI](https://supabase.com/docs/guides/cli) i prijava: `supabase login`.

1. Ključ iz [AI Studija](https://aistudio.google.com) → **Get API key** upiši kao tajnu projekta (ne u `config.js` i ne u kod):

```bash
supabase secrets set --project-ref <PROJEKAT> GEMINI_API_KEY=<tvoj ključ>
```

2. Objavi funkciju:

```bash
supabase functions deploy ai --project-ref <PROJEKAT>
```

3. Prijavi se u aplikaciji Google-om, pa u SQL Editoru postavi sebe za administratora:

```sql
select public.make_admin('tvoj@gmail.com');
```

U aplikaciji se zatim u **Podešavanja → Nalog** pojavi **Admin panel**. Tu menjaš:
- prekidač za besplatan AI;
- dnevni limit (podrazumevano 20 poziva po korisniku, administratori nemaju limit);
- model;
- korisnike: limit po korisniku, blokiranje i admin prava.

Na besplatnom nivou Gemini ima ograničen broj zahteva po minutu i danu, i to za tvoj ključ ukupno, za sve korisnike zajedno. Kad se potroši, korisnici dobijaju poruku da probaju kasnije ili upišu svoj ključ. Google na besplatnom nivou sme da koristi poslat materijal za unapređenje svojih modela.

## 4. Podsetnici (nije obavezno)

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
