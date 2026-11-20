-- Booking links: revoke, and link metadata in the webhook payload.
-- Members have no UPDATE on booking_links (they could otherwise clear used_at or extend expires_at), so revoking goes
-- through a security definer function that only sets revoked_at. The row stays: bookings.link_id is ON DELETE SET NULL,
-- and deleting would drop the link metadata from past bookings and their later outbox rows.

alter table public.booking_links add column revoked_at timestamptz check (revoked_at is null or revoked_at >= created_at);

-- True if the link was open and is revoked now; false for unknown, foreign or already revoked links.
create function public.revoke_booking_link(p_link_id uuid) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.booking_links l set revoked_at = greatest(now(), l.created_at)
  where l.id = p_link_id
    and l.revoked_at is null
    and (select public.is_active_profile())
    and (l.host_id = (select auth.uid()) or (select public.is_admin()));
  return found;
end;
$$;

revoke execute on function public.revoke_booking_link(uuid) from public, anon;
grant execute on function public.revoke_booking_link(uuid) to authenticated;

-- Payload: the link's id and metadata travel with every outbox row of a link booking (created, rescheduled, cancelled,
-- host changed), so a webhook consumer gets the caller data it put on the link. link is null for other bookings.
-- Same signature, so grants and every caller stay.
create or replace function public.booking_event_payload(p_booking public.bookings, p_extra jsonb default '{}'::jsonb) returns jsonb
language sql
stable
set search_path = ''
as $$
  select (to_jsonb(p_booking) - 'token_hash' - 'guest_responses' - 'google_change_until')
    || jsonb_build_object('link', (select jsonb_build_object('id', l.id, 'metadata', l.metadata) from public.booking_links l where l.id = p_booking.link_id))
    || coalesce(p_extra, '{}'::jsonb);
$$;

-- create_booking as in 20261201000400_bookings.sql, plus: a revoked link is no longer valid (P0004).

create or replace function public.create_booking(p_hold_id uuid, p_booking jsonb) returns uuid
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
      and l.revoked_at is null
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
