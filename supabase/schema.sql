-- Kartice — baza za sinhronizaciju (Supabase)
-- Nalepi ceo fajl u Supabase → SQL Editor → Run. Može da se pokrene više puta.

-- Stavke: svaki špil, kartica, stanje ponavljanja, beleška… je jedan red.
-- updated je vreme izmene na uređaju (ms); pobeđuje novija izmena.
create table if not exists public.items (
  user_id   uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  kind      text        not null,
  id        text        not null,
  data      jsonb,
  updated   bigint      not null,
  deleted   boolean     not null default false,
  server_ts timestamptz not null default clock_timestamp(),
  primary key (user_id, kind, id)
);
create index if not exists items_user_ts on public.items (user_id, server_ts);

alter table public.items enable row level security;
drop policy if exists "items: samo svoje" on public.items;
create policy "items: samo svoje" on public.items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Slanje sa uređaja: upisuje samo stavke koje su novije od onih na serveru.
create or replace function public.sync_push(rows jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare n integer;
begin
  insert into public.items (user_id, kind, id, data, updated, deleted, server_ts)
  select auth.uid(), r->>'kind', r->>'id', r->'data', (r->>'updated')::bigint,
         coalesce((r->>'deleted')::boolean, false), clock_timestamp()
  from jsonb_array_elements(rows) as r
  on conflict (user_id, kind, id) do update
    set data = excluded.data, updated = excluded.updated, deleted = excluded.deleted, server_ts = clock_timestamp()
    where public.items.updated <= excluded.updated;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.sync_push(jsonb) from public, anon;
grant execute on function public.sync_push(jsonb) to authenticated;

-- Fajlovi (PDF, Word, slike): privatni bucket, svaki korisnik u svom folderu <user_id>/<fileId>.
insert into storage.buckets (id, name, public, file_size_limit)
values ('files', 'files', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "files: čitanje svojih" on storage.objects;
drop policy if exists "files: upis svojih" on storage.objects;
drop policy if exists "files: izmena svojih" on storage.objects;
drop policy if exists "files: brisanje svojih" on storage.objects;
create policy "files: čitanje svojih" on storage.objects for select to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "files: upis svojih" on storage.objects for insert to authenticated
  with check (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "files: izmena svojih" on storage.objects for update to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "files: brisanje svojih" on storage.objects for delete to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);

-- Podsetnici: pretplata uređaja na obaveštenja (Web Push) i vreme podsetnika po lokalnom vremenu.
create table if not exists public.push_subs (
  endpoint  text        primary key,
  user_id   uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  sub       jsonb       not null,
  remind_at text        not null,           -- 'HH:MM'
  tz        text        not null,           -- npr. 'Europe/Belgrade'
  last_sent date,
  created   timestamptz not null default now()
);
alter table public.push_subs enable row level security;
drop policy if exists "push: samo svoje" on public.push_subs;
create policy "push: samo svoje" on public.push_subs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
