/* Kartice — podešavanje servisa
   Supabase (nalog i sinhronizacija): Project URL i anon public ključ iz Supabase → Settings → API.
   Oba su javna (zaštitu daju pravila u supabase/schema.sql), pa smeju da budu u aplikaciji.
   Prazno = sinhronizacija je isključena i aplikacija radi samo na uređaju, kao ranije. */
var SUPABASE_URL = 'https://tgfxlifgxqkhimxhxfho.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_PXtAnlGrYVcXiK0GaJy-zw_KO1P9YSL';   // javni (publishable) ključ
// javni VAPID ključ za podsetnike (Web Push); par ključeva se pravi jednom, vidi supabase/README.md
var VAPID_PUBLIC_KEY = '';
