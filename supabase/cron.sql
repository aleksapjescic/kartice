-- Kartice — pokretanje podsetnika svakih 15 minuta (posle deploy-a funkcije 'reminders')
-- Zameni <PROJEKAT> (deo adrese projekta, npr. abcd1234) i <CRON_SECRET> (ista vrednost kao u
-- `supabase secrets set CRON_SECRET=...`), pa nalepi u SQL Editor → Run.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('kartice-podsetnici') where exists (select 1 from cron.job where jobname = 'kartice-podsetnici');
select cron.schedule(
  'kartice-podsetnici',
  '*/15 * * * *',
  $$ select net.http_post(
       url := 'https://<PROJEKAT>.supabase.co/functions/v1/reminders',
       headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
       body := '{}'::jsonb
     ) $$
);
