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

-- ============================================================================================
-- Nalozi, admin i AI preko ključa aplikacije (Edge Function 'ai', supabase/functions/ai).
-- Profil, potrošnju i podešavanja menjaju samo funkcije ispod; aplikacija ih samo čita.
-- Dan za limit se računa po beogradskom vremenu.

create table if not exists public.profiles (
  user_id     uuid        primary key references auth.users (id) on delete cascade,
  email       text,
  name        text,
  role        text        not null default 'user' check (role in ('user', 'admin')),
  blocked     boolean     not null default false,
  daily_limit integer     check (daily_limit is null or daily_limit >= 0),   -- null = podrazumevani
  created     timestamptz not null default now(),
  last_seen   timestamptz
);
alter table public.profiles enable row level security;
drop policy if exists "profiles: svoj" on public.profiles;
create policy "profiles: svoj" on public.profiles for select to authenticated using (auth.uid() = user_id);

create table if not exists public.ai_usage (
  user_id uuid    not null references auth.users (id) on delete cascade,
  day     date    not null,
  calls   integer not null default 0,
  tokens  bigint  not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;
drop policy if exists "ai_usage: svoja" on public.ai_usage;
create policy "ai_usage: svoja" on public.ai_usage for select to authenticated using (auth.uid() = user_id);

create table if not exists public.app_config (
  id                  integer primary key default 1 check (id = 1),
  shared_key_on       boolean not null default true,
  default_daily_limit integer not null default 20 check (default_daily_limit >= 0),
  model               text    not null default 'gemini-2.5-flash'
);
insert into public.app_config (id) values (1) on conflict (id) do nothing;
alter table public.app_config enable row level security;
drop policy if exists "app_config: čitanje" on public.app_config;
create policy "app_config: čitanje" on public.app_config for select to authenticated using (true);

create or replace function public.ai_today() returns date
language sql stable set search_path = public
as $$ select (now() at time zone 'Europe/Belgrade')::date $$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.profiles where user_id = auth.uid() and role = 'admin') $$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- profil se pravi pri registraciji; postojeći nalozi ga dobijaju odmah ispod
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (user_id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'))
  on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
insert into public.profiles (user_id, email, name)
select id, email, coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name') from auth.users
on conflict (user_id) do nothing;

-- Aplikacija posle prijave: beleži aktivnost i vraća stanje za AI (uloga, blokada, limit, potrošnja danas).
create or replace function public.touch_profile() returns jsonb
language plpgsql security definer set search_path = public
as $$
declare p public.profiles; c public.app_config; used integer;
begin
  if auth.uid() is null then raise exception 'nije prijavljen' using errcode = '42501'; end if;
  insert into public.profiles (user_id, email, last_seen) values (auth.uid(), auth.jwt()->>'email', now())
  on conflict (user_id) do update set last_seen = now(), email = coalesce(excluded.email, public.profiles.email)
  returning * into p;
  select * into c from public.app_config where id = 1;
  select calls into used from public.ai_usage where user_id = auth.uid() and day = public.ai_today();
  return jsonb_build_object('role', p.role, 'blocked', p.blocked, 'on', c.shared_key_on, 'used', coalesce(used, 0),
    'limit', case when p.role = 'admin' then null else coalesce(p.daily_limit, c.default_daily_limit) end);
end $$;
revoke all on function public.touch_profile() from public, anon;
grant execute on function public.touch_profile() to authenticated;

-- Edge Function pre poziva Google-a: u jednom koraku proverava blokadu, prekidač i limit i broji poziv.
-- Admini nemaju limit. Zove je samo server (service_role), nikad aplikacija.
create or replace function public.ai_take(uid uuid) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare p public.profiles; c public.app_config; lim integer; used integer; d date := public.ai_today();
begin
  select * into c from public.app_config where id = 1;
  select * into p from public.profiles where user_id = uid;
  if not found then
    insert into public.profiles (user_id, email) select id, email from auth.users where id = uid
    on conflict (user_id) do nothing;
    select * into p from public.profiles where user_id = uid;
    if not found then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  end if;
  if p.blocked then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  if not c.shared_key_on then return jsonb_build_object('ok', false, 'reason', 'disabled'); end if;
  lim := case when p.role = 'admin' then null else coalesce(p.daily_limit, c.default_daily_limit) end;
  if lim is not null and lim <= 0 then return jsonb_build_object('ok', false, 'reason', 'limit', 'used', 0, 'limit', 0); end if;
  insert into public.ai_usage as u (user_id, day, calls) values (uid, d, 1)
  on conflict (user_id, day) do update set calls = u.calls + 1 where lim is null or u.calls < lim
  returning calls into used;
  if used is null then
    select calls into used from public.ai_usage where user_id = uid and day = d;
    return jsonb_build_object('ok', false, 'reason', 'limit', 'used', used, 'limit', lim);
  end if;
  return jsonb_build_object('ok', true, 'used', used, 'limit', lim, 'model', c.model);
end $$;
revoke all on function public.ai_take(uuid) from public, anon, authenticated;
grant execute on function public.ai_take(uuid) to service_role;

-- posle odgovora: dodaje tokene; neuspeo poziv se ne računa u limit
create or replace function public.ai_finish(uid uuid, tokens bigint, ok boolean) returns void
language sql security definer set search_path = public
as $$
  update public.ai_usage
  set tokens = ai_usage.tokens + greatest(coalesce(ai_finish.tokens, 0), 0),
      calls = case when ai_finish.ok then ai_usage.calls else greatest(ai_usage.calls - 1, 0) end
  where user_id = uid and day = public.ai_today();
$$;
revoke all on function public.ai_finish(uuid, bigint, boolean) from public, anon, authenticated;
grant execute on function public.ai_finish(uuid, bigint, boolean) to service_role;

-- Admin: spisak korisnika sa potrošnjom danas i ovog meseca
create or replace function public.admin_users()
returns table (user_id uuid, email text, name text, role text, blocked boolean, daily_limit integer,
               created timestamptz, last_seen timestamptz, today_calls integer, today_tokens bigint,
               month_calls integer, month_tokens bigint)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare d date := public.ai_today();
begin
  if not public.is_admin() then raise exception 'Samo za administratore.' using errcode = '42501'; end if;
  return query
  select p.user_id, p.email, p.name, p.role, p.blocked, p.daily_limit, p.created, p.last_seen,
         coalesce(t.calls, 0), coalesce(t.tokens, 0)::bigint, coalesce(m.calls, 0)::integer, coalesce(m.tokens, 0)::bigint
  from public.profiles p
  left join public.ai_usage t on t.user_id = p.user_id and t.day = d
  left join (select a.user_id, sum(a.calls) as calls, sum(a.tokens) as tokens from public.ai_usage a
             where a.day >= date_trunc('month', d)::date group by a.user_id) m on m.user_id = p.user_id
  order by p.last_seen desc nulls last, p.created desc;
end $$;
revoke all on function public.admin_users() from public, anon;
grant execute on function public.admin_users() to authenticated;

-- Admin: izmena korisnika. patch: { role?, blocked?, daily_limit? (null = podrazumevani) }
create or replace function public.admin_set_user(uid uuid, patch jsonb) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Samo za administratore.' using errcode = '42501'; end if;
  if patch ? 'role' then
    if patch->>'role' not in ('user', 'admin') then raise exception 'Nepoznata uloga.'; end if;
    if patch->>'role' = 'user' and (select role from public.profiles where user_id = uid) = 'admin'
       and (select count(*) from public.profiles where role = 'admin') <= 1 then
      raise exception 'Mora da ostane bar jedan administrator.';
    end if;
    update public.profiles set role = patch->>'role' where user_id = uid;
  end if;
  if patch ? 'blocked' then
    if uid = auth.uid() and (patch->>'blocked')::boolean then raise exception 'Ne možeš da blokiraš sebe.'; end if;
    update public.profiles set blocked = (patch->>'blocked')::boolean where user_id = uid;
  end if;
  if patch ? 'daily_limit' then
    update public.profiles set daily_limit = (patch->>'daily_limit')::integer where user_id = uid;
  end if;
end $$;
revoke all on function public.admin_set_user(uuid, jsonb) from public, anon;
grant execute on function public.admin_set_user(uuid, jsonb) to authenticated;

-- Admin: podešavanja ključa aplikacije. patch: { shared_key_on?, default_daily_limit?, model? }
create or replace function public.admin_set_config(patch jsonb) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Samo za administratore.' using errcode = '42501'; end if;
  update public.app_config set
    shared_key_on = coalesce((patch->>'shared_key_on')::boolean, shared_key_on),
    default_daily_limit = coalesce((patch->>'default_daily_limit')::integer, default_daily_limit),
    model = coalesce(nullif(trim(patch->>'model'), ''), model)
  where id = 1;
end $$;
revoke all on function public.admin_set_config(jsonb) from public, anon;
grant execute on function public.admin_set_config(jsonb) to authenticated;

-- Prvi administrator, samo iz SQL Editora (posle prve prijave u aplikaciji):
--   select public.make_admin('tvoj@gmail.com');
create or replace function public.make_admin(mail text) returns text
language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  update public.profiles set role = 'admin' where lower(email) = lower(trim(mail));
  get diagnostics n = row_count;
  return case when n > 0 then 'Gotovo: ' || mail || ' je administrator.'
              else 'Nalog ' || mail || ' nije pronađen. Prvo se prijavi u aplikaciji, pa ponovo pokreni.' end;
end $$;
revoke all on function public.make_admin(text) from public, anon, authenticated;
