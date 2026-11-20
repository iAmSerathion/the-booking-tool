-- Bookings: booked times, holds while the Google event is created, rate limit, and the transactional webhook outbox.
-- Invitee-facing writes run as service_role from server code (security invoker functions below). Signed-in members read
-- their own bookings (admins read all) and cancel through cancel_booking_as_host.

create type public.booking_state as enum ('booked', 'cancelled');
create type public.booking_cancelled_by as enum ('invitee', 'host');
create type public.booked_via as enum ('page', 'person_link', 'link', 'widget');

-- Bookings ---------------------------------------------------------------------------------

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  event_type_id uuid not null references public.event_types (id),
  host_id uuid not null references public.profiles (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  state public.booking_state not null default 'booked',
  cancelled_by public.booking_cancelled_by,
  booked_via public.booked_via not null,
  widget_id uuid references public.booking_widgets (id) on delete set null,
  link_id uuid references public.booking_links (id) on delete set null,
  -- Page the widget was embedded on: origin + path, validated by server code first.
  booking_page text check (booking_page is null or char_length(booking_page) between 1 and 300),
  invitee_name text not null,
  invitee_email extensions.citext not null,
  invitee_company text,
  invitee_phone text,
  -- Time zone the invitee picked; mails show times in it.
  invitee_timezone text,
  topic text,
  -- Answers to the event type's questions as the invitee saw them: [{id, question, answer}].
  answers jsonb check (answers is null or jsonb_typeof(answers) = 'array'),
  google_event_id text,
  meet_url text,
  reschedule_count integer not null default 0 check (reschedule_count >= 0),
  -- Last seen guest responses (lower-case email -> responseStatus), so a decline counts once.
  guest_responses jsonb not null default '{}'::jsonb,
  -- While the tool edits the Google event itself, calendar sync skips this booking until then.
  google_change_until timestamptz,
  -- sha256 hex of the invitee's reschedule/cancel token.
  token_hash text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check ((state = 'cancelled') = (cancelled_by is not null))
);

create index bookings_host_booked_idx on public.bookings (host_id, starts_at) where state = 'booked';
create index bookings_google_event_idx on public.bookings (google_event_id) where google_event_id is not null;
-- Expression index: the duplicate check compares lower(text), since citext operators are not on the empty search_path.
create index bookings_invitee_email_idx on public.bookings (lower(invitee_email::text), starts_at) where state = 'booked';

create trigger bookings_updated_at before update on public.bookings
  for each row execute function public.set_updated_at();

-- Extra links to a booking (e.g. a reminder's reschedule link). Only hashes are stored.
create table public.booking_tokens (
  token_hash text primary key,
  booking_id uuid not null references public.bookings (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index booking_tokens_booking_idx on public.booking_tokens (booking_id);

-- Short hold on a time while the Google event is created.
create table public.slot_holds (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.profiles (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  expires_at timestamptz not null default now() + interval '2 minutes',
  created_at timestamptz not null default now()
);

create index slot_holds_host_idx on public.slot_holds (host_id, starts_at);

-- Booking attempts per IP hash (rate limit); rows live one hour.
create table public.booking_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  at timestamptz not null default now()
);

create index booking_attempts_ip_idx on public.booking_attempts (ip_hash, at);

-- Transactional outbox: written in the same transaction as the booking change, delivered later as webhooks.
create table public.booking_outbox (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('booking.created', 'booking.rescheduled', 'booking.cancelled')),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  payload jsonb not null,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  delivered_at timestamptz,
  last_error text,
  -- clock_timestamp: rows written in one transaction still keep their order.
  created_at timestamptz not null default clock_timestamp()
);

create index booking_outbox_booking_idx on public.booking_outbox (booking_id);
create index booking_outbox_due_idx on public.booking_outbox (next_attempt_at) where delivered_at is null;

-- Row level security -----------------------------------------------------------------------

alter table public.bookings enable row level security;
alter table public.booking_tokens enable row level security;
alter table public.slot_holds enable row level security;
alter table public.booking_attempts enable row level security;
alter table public.booking_outbox enable row level security;

create policy "Hosts and admins read bookings" on public.bookings
  for select to authenticated
  using ((select public.is_active_profile()) and (host_id = (select auth.uid()) or (select public.is_admin())));

-- Explicit, because Supabase default privileges grant everything on new public tables to anon and authenticated.
revoke all on public.bookings, public.booking_tokens, public.slot_holds, public.booking_attempts, public.booking_outbox
  from anon, authenticated;
grant select on public.bookings to authenticated;
grant select, insert, update, delete on public.bookings, public.booking_tokens, public.slot_holds, public.booking_attempts,
  public.booking_outbox to service_role;

-- Outbox payload ---------------------------------------------------------------------------
-- What a webhook consumer sees: the booking without its token hash and sync internals, plus event-specific keys.

create function public.booking_event_payload(p_booking public.bookings, p_extra jsonb default '{}'::jsonb) returns jsonb
language sql
stable
set search_path = ''
as $$
  select (to_jsonb(p_booking) - 'token_hash' - 'guest_responses' - 'google_change_until') || coalesce(p_extra, '{}'::jsonb);
$$;

-- Rate limit -------------------------------------------------------------------------------
-- True if the attempt counts and is under the limit; it also purges rows older than an hour.

create function public.booking_attempt(p_ip_hash text, p_limit integer default 10) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.booking_attempts where at < now() - interval '1 hour';
  select count(*) into v_count from public.booking_attempts where ip_hash = p_ip_hash and at > now() - interval '1 minute';
  if v_count >= p_limit then
    return false;
  end if;
  insert into public.booking_attempts (ip_hash) values (p_ip_hash);
  return true;
end;
$$;

-- Hold a slot ------------------------------------------------------------------------------
-- Under a per-host lock: the time is taken if a booked booking of the host overlaps it including buffer, or another live
-- hold overlaps it. The day is full when it already has p_max_per_day bookings (p_day_from..p_day_to is the day in the
-- host's time zone). p_except_booking (reschedule) neither blocks nor counts. Returns the hold id, or null.

create function public.hold_slot(
  p_host_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_buffer_minutes integer,
  p_max_per_day integer,
  p_day_from timestamptz,
  p_day_to timestamptz,
  p_except_booking uuid default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_buffer interval := make_interval(mins => p_buffer_minutes);
  v_hold uuid;
begin
  perform pg_advisory_xact_lock(hashtext('booking:' || p_host_id::text));
  delete from public.slot_holds where expires_at < now();

  if exists (
    select 1 from public.bookings b
    where b.state = 'booked'
      and b.id is distinct from p_except_booking
      and b.host_id = p_host_id
      and b.starts_at - v_buffer < p_ends_at
      and b.ends_at + v_buffer > p_starts_at
  ) or exists (
    select 1 from public.slot_holds h
    where h.host_id = p_host_id and h.starts_at < p_ends_at and h.ends_at > p_starts_at
  ) then
    return null;
  end if;

  if (
    select count(*) from public.bookings b
    where b.state = 'booked'
      and b.id is distinct from p_except_booking
      and b.host_id = p_host_id
      and b.starts_at >= p_day_from and b.starts_at < p_day_to
  ) >= p_max_per_day then
    return null;
  end if;

  insert into public.slot_holds (host_id, starts_at, ends_at)
  values (p_host_id, p_starts_at, p_ends_at)
  returning id into v_hold;
  return v_hold;
end;
$$;

create function public.release_hold(p_hold_id uuid) returns void
language sql
set search_path = ''
as $$
  delete from public.slot_holds where id = p_hold_id;
$$;

-- Create a booking -------------------------------------------------------------------------
-- p_booking: {id?, event_type_id, host_id, starts_at, ends_at, booked_via, widget_id?, link_id?, booking_page?,
--   invitee_name, invitee_email, invitee_company?, invitee_phone?, invitee_timezone?, topic?, answers?,
--   google_event_id?, meet_url?, token_hash?, check_upcoming?}
-- Server code holds the slot, creates the Google event, then calls this; on error it deletes the event and releases the
-- hold. Errors: P0002 hold gone, P0003 invitee already has an upcoming booking of this event type, P0004 link no longer
-- valid. Returns the booking id.

create function public.create_booking(p_hold_id uuid, p_booking jsonb) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_host uuid := (p_booking ->> 'host_id')::uuid;
  v_event_type uuid := (p_booking ->> 'event_type_id')::uuid;
  v_starts timestamptz := (p_booking ->> 'starts_at')::timestamptz;
  v_ends timestamptz := (p_booking ->> 'ends_at')::timestamptz;
  v_email text := lower(btrim(p_booking ->> 'invitee_email'));
  v_check boolean := coalesce((p_booking ->> 'check_upcoming')::boolean, false);
  v_link uuid := (p_booking ->> 'link_id')::uuid;
  v_row public.bookings%rowtype;
begin
  -- Invitee lock first, then host lock, so two bookings for the same invitee wait for each other even with different
  -- hosts.
  if v_check then
    perform pg_advisory_xact_lock(hashtext('invitee:' || v_email));
  end if;
  perform pg_advisory_xact_lock(hashtext('booking:' || v_host::text));
  -- deactivate_profile takes the same host lock, so a host deactivated after hold_slot cannot be booked.
  if not exists (select 1 from public.profiles p where p.id = v_host and p.active and p.bookable) then
    raise exception 'The host can no longer be booked.' using errcode = 'P0002';
  end if;
  -- The hold must still exist under the host lock and match the booked time.
  delete from public.slot_holds
  where id = p_hold_id and host_id = v_host and starts_at = v_starts and ends_at = v_ends;
  if not found then
    raise exception 'The hold has expired.' using errcode = 'P0002';
  end if;

  if v_check and exists (
    select 1 from public.bookings b
    where lower(b.invitee_email::text) = v_email
      and b.event_type_id = v_event_type
      and b.state = 'booked' and b.starts_at > now()
  ) then
    raise exception 'The invitee already has an upcoming booking.' using errcode = 'P0003';
  end if;

  -- Single use, expiry, host and event type of the link. The row lock serialises two bookings on the same link.
  if v_link is not null then
    update public.booking_links l set used_at = coalesce(l.used_at, now())
    where l.id = v_link
      and l.host_id = v_host
      and l.event_type_id = v_event_type
      and (not l.single_use or l.used_at is null)
      and (l.expires_at is null or l.expires_at > now())
      and exists (select 1 from public.profiles p where p.id = l.host_id and p.active and p.bookable);
    if not found then
      raise exception 'The booking link is no longer valid.' using errcode = 'P0004';
    end if;
  end if;

  insert into public.bookings (
    id, event_type_id, host_id, starts_at, ends_at, booked_via, widget_id, link_id, booking_page,
    invitee_name, invitee_email, invitee_company, invitee_phone, invitee_timezone, topic, answers,
    google_event_id, meet_url, token_hash
  ) values (
    coalesce((p_booking ->> 'id')::uuid, gen_random_uuid()),
    v_event_type,
    v_host,
    v_starts,
    v_ends,
    (p_booking ->> 'booked_via')::public.booked_via,
    (p_booking ->> 'widget_id')::uuid,
    v_link,
    nullif(p_booking ->> 'booking_page', ''),
    btrim(p_booking ->> 'invitee_name'),
    v_email,
    nullif(btrim(p_booking ->> 'invitee_company'), ''),
    nullif(btrim(p_booking ->> 'invitee_phone'), ''),
    nullif(p_booking ->> 'invitee_timezone', ''),
    nullif(btrim(p_booking ->> 'topic'), ''),
    case when jsonb_typeof(p_booking -> 'answers') = 'array' then p_booking -> 'answers' end,
    p_booking ->> 'google_event_id',
    p_booking ->> 'meet_url',
    p_booking ->> 'token_hash'
  )
  returning * into v_row;

  insert into public.booking_outbox (type, booking_id, payload)
  values ('booking.created', v_row.id, public.booking_event_payload(v_row));
  return v_row.id;
end;
$$;

-- Reschedule (same row, reschedule_count + 1) ----------------------------------------------
-- The hold was taken with hold_slot(..., p_except_booking => p_booking_id) and must match the new time.
-- Returns the new reschedule_count.

create function public.reschedule_booking(
  p_booking_id uuid,
  p_hold_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_invitee_timezone text default null
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_host uuid;
  v_old public.bookings%rowtype;
  v_row public.bookings%rowtype;
begin
  -- Host lock before the row lock, the same order as deactivate_profile; otherwise the two deadlock.
  select host_id into v_host from public.bookings where id = p_booking_id;
  if not found then
    raise exception 'The booking can no longer be changed.' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtext('booking:' || v_host::text));

  select * into v_old from public.bookings where id = p_booking_id for update;
  -- A concurrent deactivation may have moved the booking to a successor while we waited.
  if v_old.state <> 'booked' or v_old.starts_at <= now() or v_old.host_id <> v_host then
    raise exception 'The booking can no longer be changed.' using errcode = 'P0002';
  end if;

  delete from public.slot_holds
  where id = p_hold_id and host_id = v_old.host_id and starts_at = p_starts_at and ends_at = p_ends_at;
  if not found then
    raise exception 'The hold has expired.' using errcode = 'P0002';
  end if;

  update public.bookings
  set starts_at = p_starts_at,
      ends_at = p_ends_at,
      reschedule_count = reschedule_count + 1,
      invitee_timezone = coalesce(nullif(p_invitee_timezone, ''), invitee_timezone)
  where id = p_booking_id
  returning * into v_row;

  insert into public.booking_outbox (type, booking_id, payload)
  values ('booking.rescheduled', v_row.id, public.booking_event_payload(v_row, jsonb_build_object(
    'previous', jsonb_build_object('starts_at', v_old.starts_at, 'ends_at', v_old.ends_at),
    'changed_by', 'invitee')));
  return v_row.reschedule_count;
end;
$$;

-- Cancel -----------------------------------------------------------------------------------
-- Only future booked bookings. Booking jobs stop through the jobs domain's trigger on state.

create function public.cancel_booking(
  p_booking_id uuid,
  p_cancelled_by public.booking_cancelled_by default 'invitee',
  p_reason text default null
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_row public.bookings%rowtype;
begin
  select * into v_row from public.bookings where id = p_booking_id for update;
  if not found or v_row.state <> 'booked' or v_row.starts_at <= now() then
    raise exception 'The booking can no longer be changed.' using errcode = 'P0002';
  end if;

  update public.bookings set state = 'cancelled', cancelled_by = coalesce(p_cancelled_by, 'invitee')
  where id = p_booking_id
  returning * into v_row;

  insert into public.booking_outbox (type, booking_id, payload)
  values ('booking.cancelled', v_row.id, public.booking_event_payload(v_row, jsonb_build_object(
    'reason', nullif(btrim(p_reason), ''),
    'changed_by', v_row.cancelled_by)));
end;
$$;

-- Host cancel from the admin UI: the host themself or an admin. Server code deletes the Google event afterwards.
create function public.cancel_booking_as_host(p_booking_id uuid, p_reason text default null) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.bookings
    where id = p_booking_id and public.is_active_profile() and (host_id = (select auth.uid()) or public.is_admin())
  ) then
    raise exception 'Only the host or an admin can cancel this booking.' using errcode = '42501';
  end if;
  perform public.cancel_booking(p_booking_id, 'host', p_reason);
end;
$$;

-- Link to book again after a cancellation --------------------------------------------------
-- A single-use link to the same host and event type, prefilled with the invitee. False if the booking is not cancelled
-- or its host can no longer take bookings.

create function public.rebook_link(p_booking_id uuid, p_token_hash text) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_row public.bookings%rowtype;
begin
  select b.* into v_row
  from public.bookings b
  join public.profiles p on p.id = b.host_id
  where b.id = p_booking_id and b.state = 'cancelled' and p.active and p.bookable;
  if not found then
    return false;
  end if;
  insert into public.booking_links (token_hash, host_id, event_type_id, prefill, metadata, single_use)
  values (
    p_token_hash, v_row.host_id, v_row.event_type_id,
    jsonb_strip_nulls(jsonb_build_object(
      'name', v_row.invitee_name, 'email', v_row.invitee_email::text, 'company', v_row.invitee_company,
      'phone', v_row.invitee_phone, 'timezone', v_row.invitee_timezone)),
    jsonb_build_object('rebook_of', v_row.id),
    true
  );
  return true;
end;
$$;

-- Calendar sync: the event changed in Google -----------------------------------------------
-- p_plan: {moved?: {starts_at, ends_at}, responses?: {...}}. The host moved it, so reschedule_count stays. No hold or host
-- lock: Google is the source of truth for host-side moves. Only for booked bookings; returns whether it applied.

create function public.calendar_booking_update(p_booking_id uuid, p_plan jsonb) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_old public.bookings%rowtype;
  v_row public.bookings%rowtype;
begin
  select * into v_old from public.bookings where id = p_booking_id for update;
  if not found or v_old.state <> 'booked' then
    return false;
  end if;

  update public.bookings
  set starts_at = coalesce((p_plan -> 'moved' ->> 'starts_at')::timestamptz, starts_at),
      ends_at = coalesce((p_plan -> 'moved' ->> 'ends_at')::timestamptz, ends_at),
      guest_responses = coalesce(p_plan -> 'responses', guest_responses)
  where id = p_booking_id
  returning * into v_row;

  -- A move made in the calendar is a reschedule for webhook consumers too.
  if (v_row.starts_at, v_row.ends_at) is distinct from (v_old.starts_at, v_old.ends_at) then
    insert into public.booking_outbox (type, booking_id, payload)
    values ('booking.rescheduled', v_row.id, public.booking_event_payload(v_row, jsonb_build_object(
      'previous', jsonb_build_object('starts_at', v_old.starts_at, 'ends_at', v_old.ends_at),
      'changed_by', 'calendar')));
  end if;
  return true;
end;
$$;

-- Calendar sync: the host deleted or declined the event ------------------------------------

create function public.calendar_booking_deleted(p_booking_id uuid) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_row public.bookings%rowtype;
begin
  select * into v_row from public.bookings where id = p_booking_id for update;
  if not found or v_row.state <> 'booked' then
    return false;
  end if;

  update public.bookings set state = 'cancelled', cancelled_by = 'host'
  where id = p_booking_id
  returning * into v_row;

  insert into public.booking_outbox (type, booking_id, payload)
  values ('booking.cancelled', v_row.id, public.booking_event_payload(v_row, jsonb_build_object(
    'reason', null, 'changed_by', 'calendar')));
  return true;
end;
$$;

-- Function grants: service_role only, except the host cancel (Supabase grants new functions to anon and authenticated).
revoke execute on function public.booking_event_payload(public.bookings, jsonb) from public, anon, authenticated;
revoke execute on function public.booking_attempt(text, integer) from public, anon, authenticated;
revoke execute on function public.hold_slot(uuid, timestamptz, timestamptz, integer, integer, timestamptz, timestamptz, uuid)
  from public, anon, authenticated;
revoke execute on function public.release_hold(uuid) from public, anon, authenticated;
revoke execute on function public.create_booking(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.reschedule_booking(uuid, uuid, timestamptz, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.cancel_booking(uuid, public.booking_cancelled_by, text) from public, anon, authenticated;
revoke execute on function public.cancel_booking_as_host(uuid, text) from public, anon;
revoke execute on function public.rebook_link(uuid, text) from public, anon, authenticated;
revoke execute on function public.calendar_booking_update(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.calendar_booking_deleted(uuid) from public, anon, authenticated;

grant execute on function public.booking_event_payload(public.bookings, jsonb) to service_role;
grant execute on function public.booking_attempt(text, integer) to service_role;
grant execute on function public.hold_slot(uuid, timestamptz, timestamptz, integer, integer, timestamptz, timestamptz, uuid)
  to service_role;
grant execute on function public.release_hold(uuid) to service_role;
grant execute on function public.create_booking(uuid, jsonb) to service_role;
grant execute on function public.reschedule_booking(uuid, uuid, timestamptz, timestamptz, text) to service_role;
grant execute on function public.cancel_booking(uuid, public.booking_cancelled_by, text) to service_role;
grant execute on function public.cancel_booking_as_host(uuid, text) to authenticated;
grant execute on function public.rebook_link(uuid, text) to service_role;
grant execute on function public.calendar_booking_update(uuid, jsonb) to service_role;
grant execute on function public.calendar_booking_deleted(uuid) to service_role;
