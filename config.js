/* Kartice — podešavanje servisa
   Supabase (nalog i sinhronizacija): Project URL i anon public ključ iz Supabase → Settings → API.
   Oba su javna (zaštitu daju pravila u supabase/schema.sql), pa smeju da budu u aplikaciji.
   Prazno = sinhronizacija je isključena i aplikacija radi samo na uređaju, kao ranije. */
var SUPABASE_URL = '';
var SUPABASE_ANON_KEY = '';
// javni VAPID ključ za podsetnike (Web Push); par ključeva se pravi jednom, vidi supabase/README.md
var VAPID_PUBLIC_KEY = '';
