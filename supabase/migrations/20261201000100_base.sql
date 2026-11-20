-- Base: extensions, shared trigger, team profiles, instance settings.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;
-- Holds Google refresh tokens (calendar_connections.refresh_token_secret_id).
create extension if not exists supabase_vault;

-- Shared updated_at trigger ----------------------------------------------------------------

create function public.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Profiles: one row per team member, linked to auth.users ----------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete restrict,
  name text not null,
  email extensions.citext not null unique,
  -- Personal booking page /<slug>. Reserved words are the app's top-level routes; keep in sync with the app's reserved slug list.
  slug text unique constraint profiles_slug_check check (
    slug ~ '^[a-z0-9-]+$'
    and slug not in ('app', 'l', 'api', 'auth', 'login', 'confirmed', 'reschedule', 'cancel', 'widget', 'privacy', 'imprint')
  ),
  timezone text not null default 'Europe/Berlin',
  buffer_minutes integer not null default 15
    constraint profiles_buffer_minutes_range check (buffer_minutes between 0 and 240),
  min_notice_hours integer not null default 24
    constraint profiles_min_notice_hours_range check (min_notice_hours between 0 and 720),
  max_bookings_per_day integer not null default 3
    constraint profiles_max_bookings_per_day_range check (max_bookings_per_day between 1 and 20),
  meet_auto boolean not null default true,
  is_admin boolean not null default false,
  bookable boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Is the signed-in user an active member? Security definer so the profiles policy does not query itself.
create function public.is_active_profile() returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and active);
$$;

-- Is the signed-in user an active admin? For "or admin" policies in other domains.
create function public.is_admin() returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.active and p.is_admin);
$$;

-- Guard for admin-only security-definer functions. Not callable directly; definer functions run it as owner.
create function public.assert_is_admin() returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can change this.' using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.is_active_profile() from public, anon;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.assert_is_admin() from public, anon, authenticated;
grant execute on function public.is_active_profile() to authenticated;
grant execute on function public.is_admin() to authenticated;

alter table public.profiles enable row level security;

-- Active members see the team. Deactivated users do not even see their own row; the app relies on this.
create policy "Members read the team" on public.profiles
  for select to authenticated
  using ((select public.is_active_profile()));

-- Members change their own booking preferences only (column grant below); rights, name, email and slug go through admin functions.
create policy "Members update their own preferences" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) and active)
  with check (id = (select auth.uid()) and active);

-- Explicit, because Supabase default privileges grant everything on new public tables to anon and authenticated.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (timezone, buffer_minutes, min_notice_hours, max_bookings_per_day, meet_auto) on public.profiles to authenticated;
grant select, insert, update, delete on public.profiles to service_role;

-- Change a member's booking slug. The old /<slug> link stops working.
create function public.set_slug(p_profile_id uuid, p_slug text) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_is_admin();
  update public.profiles set slug = p_slug where id = p_profile_id;
  if not found then
    raise exception 'Profile not found.' using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.set_slug(uuid, text) from public, anon;
grant execute on function public.set_slug(uuid, text) to authenticated;

-- Instance settings ------------------------------------------------------------------------
-- Keys and value shapes (bare jsonb, read by the app as Map<key, value>):
--   slot_horizon_days      number, days ahead that slots are offered
--   website_mode           "person" | "round_robin"
--   website_person_id      profile id as string, used when website_mode = "person"
--   default_event_type_id  event type id as string
--   brand                  {"name": string, "logo_url": string | null}; env BRAND_* is the fallback
--   event_summary_template string with {placeholders}; the built-in default is the fallback
create table public.settings (
  key text primary key,
  value jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger settings_updated_at before update on public.settings
  for each row execute function public.set_updated_at();

alter table public.settings enable row level security;

create policy "Members read settings" on public.settings
  for select to authenticated
  using ((select public.is_active_profile()));

revoke all on public.settings from anon, authenticated;
grant select on public.settings to authenticated;
grant select, insert, update, delete on public.settings to service_role;

-- A fresh install has no members yet, so the website starts in round robin.
insert into public.settings (key, value) values
  ('slot_horizon_days', '14'),
  ('website_mode', '"round_robin"');
