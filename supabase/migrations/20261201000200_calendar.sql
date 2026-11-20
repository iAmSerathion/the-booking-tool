-- Calendar: Google calendar connections (refresh token in Vault), incremental sync claims, and availability windows.

-- Calendar connections ----------------------------------------------------------------------

create type public.calendar_connection_status as enum ('ok', 'needs_reconnect');

-- One row per user. scopes are the Google scopes the tool currently uses. The refresh token itself lives only in Vault.
create table public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles (id) on delete cascade,
  -- Room for other providers later; only Google exists today.
  provider text not null default 'google' check (provider = 'google'),
  account_email text not null,
  refresh_token_secret_id uuid not null,
  scopes text[] not null default '{}',
  primary_calendar_id text,
  busy_calendar_ids text[] not null default '{}',
  status public.calendar_connection_status not null default 'ok',
  connected_at timestamptz not null default now(),
  token_refreshed_at timestamptz,
  -- Incremental sync: one sync per user at a time; a notification during a sync sets sync_again.
  sync_token text,
  synced_at timestamptz,
  sync_claimed_at timestamptz,
  sync_again boolean not null default false,
  -- Push channel on the primary calendar; only a hash of the channel secret is stored.
  channel_id text,
  channel_resource_id text,
  channel_token_hash text,
  channel_expires_at timestamptz,
  channel_renewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index calendar_connections_channel_idx on public.calendar_connections (channel_id) where channel_id is not null;

create trigger calendar_connections_updated_at before update on public.calendar_connections
  for each row execute function public.set_updated_at();

alter table public.calendar_connections enable row level security;

-- Owners read their own connection and choose their busy calendars. Creating, scopes and tokens go through the server only.
create policy "Owner reads own calendar connection" on public.calendar_connections
  for select to authenticated using (user_id = (select auth.uid()) and (select public.is_active_profile()));
create policy "Owner updates own busy calendars" on public.calendar_connections
  for update to authenticated
  using (user_id = (select auth.uid()) and (select public.is_active_profile()))
  with check (user_id = (select auth.uid()));

revoke all on public.calendar_connections from anon, authenticated;
-- No refresh_token_secret_id, sync or channel columns: those stay with the server.
grant select (id, user_id, provider, account_email, scopes, primary_calendar_id, busy_calendar_ids, status, connected_at, token_refreshed_at)
  on public.calendar_connections to authenticated;
grant update (busy_calendar_ids) on public.calendar_connections to authenticated;
grant select, insert, update, delete on public.calendar_connections to service_role;

-- Connect: store the token in Vault (new or replace) and create or refresh the connection, in one transaction.
create function public.google_connection_save(
  p_user_id uuid,
  p_account_email text,
  p_refresh_token text,
  p_scopes text[],
  p_primary_calendar_id text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
  v_name text := 'google_refresh_token_' || p_user_id::text;
begin
  -- Two parallel OAuth callbacks for the same user would otherwise both create a secret with the same name.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('calendar_connection:' || p_user_id::text, 0));

  select refresh_token_secret_id into v_secret from public.calendar_connections where user_id = p_user_id;
  if v_secret is null then
    -- A leftover secret with the same name (e.g. after an aborted disconnect) would block the insert.
    delete from vault.secrets where name = v_name;
    v_secret := vault.create_secret(p_refresh_token, v_name, 'Google refresh token of a calendar connection');
  else
    perform vault.update_secret(v_secret, p_refresh_token);
  end if;

  insert into public.calendar_connections (user_id, account_email, refresh_token_secret_id, scopes, primary_calendar_id, status, connected_at)
  values (p_user_id, lower(p_account_email), v_secret, p_scopes, p_primary_calendar_id, 'ok', now())
  on conflict (user_id) do update set
    account_email = excluded.account_email,
    refresh_token_secret_id = excluded.refresh_token_secret_id,
    scopes = excluded.scopes,
    primary_calendar_id = coalesce(excluded.primary_calendar_id, public.calendar_connections.primary_calendar_id),
    status = 'ok',
    connected_at = now();
end;
$$;

-- Read the token to get a Google access token. Null means "not connected".
create function public.google_refresh_token(p_user_id uuid) returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret
  from public.calendar_connections c
  join vault.decrypted_secrets s on s.id = c.refresh_token_secret_id
  where c.user_id = p_user_id;
$$;

-- Disconnect fully: delete the connection and its token.
create function public.google_connection_delete(p_user_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
begin
  delete from public.calendar_connections where user_id = p_user_id returning refresh_token_secret_id into v_secret;
  if v_secret is not null then
    delete from vault.secrets where id = v_secret;
  end if;
end;
$$;

-- Only the server with the service key reaches the token.
revoke execute on function public.google_connection_save(uuid, text, text, text[], text) from public, anon, authenticated;
revoke execute on function public.google_refresh_token(uuid) from public, anon, authenticated;
revoke execute on function public.google_connection_delete(uuid) from public, anon, authenticated;
grant execute on function public.google_connection_save(uuid, text, text, text[], text) to service_role;
grant execute on function public.google_refresh_token(uuid) to service_role;
grant execute on function public.google_connection_delete(uuid) to service_role;

-- Claim a sync: returns the sync token and primary calendar, or null when another sync is running (that one then syncs
-- again afterwards). A claim counts as running for two minutes; if it crashes, the next one may take over.
-- Security invoker: only service_role may execute it.
create function public.calendar_sync_claim(p_user_id uuid) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_row public.calendar_connections%rowtype;
begin
  update public.calendar_connections
  set sync_claimed_at = now(), sync_again = false
  where user_id = p_user_id
    and (sync_claimed_at is null or sync_claimed_at < now() - interval '2 minutes')
  returning * into v_row;
  if not found then
    update public.calendar_connections set sync_again = true where user_id = p_user_id;
    return null;
  end if;
  return jsonb_build_object('sync_token', v_row.sync_token, 'primary_calendar_id', v_row.primary_calendar_id);
end;
$$;

-- Release a sync: new sync token (p_save_token false keeps the old one because an event had to wait), sync time.
-- Returns whether a new notification arrived in the meantime.
create function public.calendar_sync_release(p_user_id uuid, p_sync_token text, p_save_token boolean) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_again boolean;
begin
  select sync_again into v_again from public.calendar_connections where user_id = p_user_id for update;
  update public.calendar_connections
  set sync_token = case when p_save_token then p_sync_token else sync_token end,
      synced_at = now(),
      sync_claimed_at = null,
      sync_again = false
  where user_id = p_user_id;
  return coalesce(v_again, false);
end;
$$;

revoke execute on function public.calendar_sync_claim(uuid) from public, anon, authenticated;
revoke execute on function public.calendar_sync_release(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.calendar_sync_claim(uuid) to service_role;
grant execute on function public.calendar_sync_release(uuid, text, boolean) to service_role;

-- Availability windows ------------------------------------------------------------------------
-- weekday: ISO, 1 = Monday ... 7 = Sunday. Local time in the user's timezone (profiles.timezone). 30-minute grid.
create table public.availability_windows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  start_time time not null check (extract(minute from start_time) in (0, 30) and extract(second from start_time) = 0),
  end_time time not null check (extract(minute from end_time) in (0, 30) and extract(second from end_time) = 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (start_time < end_time)
);

create index availability_windows_user on public.availability_windows (user_id, weekday, start_time);

create trigger availability_windows_updated_at before update on public.availability_windows
  for each row execute function public.set_updated_at();

alter table public.availability_windows enable row level security;

-- Members read the team's windows; each member changes only their own.
create policy "Members read availability" on public.availability_windows
  for select to authenticated using ((select public.is_active_profile()));
create policy "Owner inserts own windows" on public.availability_windows
  for insert to authenticated with check (user_id = (select auth.uid()) and (select public.is_active_profile()));
create policy "Owner deletes own windows" on public.availability_windows
  for delete to authenticated using (user_id = (select auth.uid()) and (select public.is_active_profile()));

revoke all on public.availability_windows from anon, authenticated;
grant select, insert, delete on public.availability_windows to authenticated;
grant select, insert, update, delete on public.availability_windows to service_role;

-- Replace one day's windows in one call, under the caller's RLS. Empty list = not bookable that day.
-- Overlaps are rejected with 23514 (the page checks the same first).
create function public.set_availability_day(p_weekday smallint, p_windows jsonb) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
begin
  if not (select public.is_active_profile()) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;

  delete from public.availability_windows where user_id = v_me and weekday = p_weekday;
  insert into public.availability_windows (user_id, weekday, start_time, end_time)
  select v_me, p_weekday, (w ->> 'start')::time, (w ->> 'end')::time
  from jsonb_array_elements(p_windows) w;

  if exists (
    select 1
    from public.availability_windows a
    join public.availability_windows b
      on a.user_id = b.user_id and a.weekday = b.weekday and a.id <> b.id
     and a.start_time < b.end_time and b.start_time < a.end_time
    where a.user_id = v_me and a.weekday = p_weekday
  ) then
    raise exception 'The time windows overlap.' using errcode = '23514';
  end if;
end;
$$;

revoke execute on function public.set_availability_day(smallint, jsonb) from public, anon;
grant execute on function public.set_availability_day(smallint, jsonb) to authenticated;

-- Starting windows for a new profile, from settings key default_availability: [{"weekday": 1-7, "start": "HH:MM", "end": "HH:MM"}].
-- A missing key means no starting windows. Bad values fail the profile insert through the table checks; overlaps are not
-- checked here, so whatever writes this setting must validate it like set_availability_day.
create function public.default_availability(p_user_id uuid) returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.availability_windows (user_id, weekday, start_time, end_time)
  select p_user_id, (w ->> 'weekday')::smallint, (w ->> 'start')::time, (w ->> 'end')::time
  from jsonb_array_elements(coalesce((select s.value from public.settings s where s.key = 'default_availability'), '[]')) w;
$$;

revoke execute on function public.default_availability(uuid) from public, anon, authenticated;

create function public.profiles_default_availability() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.default_availability(new.id);
  return new;
end;
$$;

revoke execute on function public.profiles_default_availability() from public, anon, authenticated;

create trigger profiles_default_availability after insert on public.profiles
  for each row execute function public.profiles_default_availability();

-- Monday to Friday, 09:00-12:00 and 14:00-17:00.
insert into public.settings (key, value)
select 'default_availability', jsonb_agg(jsonb_build_object('weekday', d, 'start', t.s, 'end', t.e) order by d, t.s)
from generate_series(1, 5) d
cross join (values ('09:00', '12:00'), ('14:00', '17:00')) t (s, e);
