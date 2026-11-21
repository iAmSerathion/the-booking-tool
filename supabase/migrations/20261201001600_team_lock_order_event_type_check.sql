-- Two race fixes.
-- 1. set_person_rights and deactivate_profile checked the acting admin before taking the 'team:admins' lock, so a
--    request that waited on the lock still went through after its admin was demoted or deactivated. The lock now comes
--    first and the check after it (read committed: the check sees the committed demotion). reactivate_profile and the
--    other admin-only functions take no team lock and are unchanged.
-- 2. create_booking checks under the host lock that the event type still exists and is active (P0002), read FOR SHARE
--    so it serialises with set_event_type_active. Otherwise as in 20261201001300_widget_booking_check.sql.
-- Same signatures as before, so grants stay.

create or replace function public.set_person_rights(p_person_id uuid, p_rights jsonb) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Lock first: a request that waited here re-checks its admin right against the committed state.
  perform pg_advisory_xact_lock(hashtext('team:admins'));
  perform public.assert_is_admin();
  update public.profiles set
    is_admin = coalesce((p_rights ->> 'is_admin')::boolean, is_admin),
    bookable = coalesce((p_rights ->> 'bookable')::boolean, bookable)
  where id = p_person_id;
  if not found then
    raise exception 'Member not found.' using errcode = 'P0002';
  end if;
  -- Widgets and the website only take bookable hosts (save_booking_widget, set_website_bookings); keep it that way.
  if (p_rights ->> 'bookable')::boolean is false and (
    exists (select 1 from public.booking_widget_hosts where user_id = p_person_id)
    or exists (
      select 1 from public.settings m join public.settings p on p.key = 'website_person_id'
      where m.key = 'website_mode' and m.value = '"person"' and p.value = to_jsonb(p_person_id::text)
    )
  ) then
    raise exception 'This member is still booked through a widget or the website. Change those first.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.profiles where active and is_admin) then
    raise exception 'At least one active member must stay an admin.' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.deactivate_profile(p_person_id uuid, p_to_id uuid, p_actor_id uuid, p_plan jsonb) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_plan jsonb := coalesce(p_plan -> 'bookings', '[]'::jsonb);
begin
  -- Lock first: a request that waited here re-checks its actor against the committed state.
  perform pg_advisory_xact_lock(hashtext('team:admins'));
  if not exists (select 1 from public.profiles where id = p_actor_id and active and is_admin) then
    raise exception 'Only admins can change this.' using errcode = '42501';
  end if;
  if p_person_id = p_actor_id then
    raise exception 'You cannot deactivate yourself.' using errcode = 'P0002';
  end if;
  if jsonb_typeof(v_plan) <> 'array' or exists (
    select 1 from jsonb_array_elements(v_plan) x where coalesce(x ->> 'google_event_id', '') = ''
  ) then
    raise exception 'Every booking needs the id of its new calendar event.' using errcode = '23514';
  end if;
  -- The same per-host lock as hold_slot and create_booking: this host's bookings cannot change until commit.
  perform pg_advisory_xact_lock(hashtext('booking:' || p_person_id::text));
  if not exists (select 1 from public.profiles where id = p_person_id and active) then
    raise exception 'This member is already deactivated.' using errcode = 'P0002';
  end if;
  if p_to_id = p_person_id or not exists (select 1 from public.profiles where id = p_to_id and active) then
    raise exception 'Please pick an active member to take over.' using errcode = 'P0002';
  end if;

  -- The plan was built before the calendar calls; refuse if the host's future bookings changed since, their times
  -- included (the new events were created at the planned times). Server code removes the new events and retries.
  if exists (
    select 1 from public.bookings b
    where b.host_id = p_person_id and b.state = 'booked' and b.starts_at > now()
      and not exists (select 1 from jsonb_array_elements(v_plan) x where (x ->> 'id')::uuid = b.id)
  ) or exists (
    select 1 from jsonb_array_elements(v_plan) x
    where not exists (
      select 1 from public.bookings b where b.id = (x ->> 'id')::uuid and b.host_id = p_person_id and b.state = 'booked'
        and b.starts_at = (x ->> 'starts_at')::timestamptz and b.ends_at = (x ->> 'ends_at')::timestamptz
    )
  ) then
    raise exception 'Bookings changed in the meantime. Please try again.' using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.profiles where id = p_to_id and bookable) and (
    jsonb_array_length(v_plan) > 0
    or exists (select 1 from public.booking_widget_hosts where user_id = p_person_id)
    or exists (select 1 from public.settings where key = 'website_person_id' and value = to_jsonb(p_person_id::text))
  ) then
    raise exception 'The member who takes over must be bookable.' using errcode = 'P0002';
  end if;

  -- Holds taken before the lock would otherwise still turn into bookings for the inactive host.
  delete from public.slot_holds where host_id = p_person_id;

  -- New host and new calendar event. Guest responses belonged to the old event, so they start over.
  update public.bookings b set
    host_id = p_to_id,
    google_event_id = p.google_event_id,
    -- The new event's link, or none: the old link belongs to the departed member's deleted event.
    meet_url = p.meet_url,
    guest_responses = '{}'::jsonb
  from jsonb_to_recordset(v_plan) as p (id uuid, google_event_id text, meet_url text)
  where b.id = p.id;

  insert into public.booking_outbox (type, booking_id, payload)
  select 'booking.host_changed', b.id,
    public.booking_event_payload(b, jsonb_build_object('previous_host_id', p_person_id, 'changed_by', 'admin'))
  from public.bookings b
  where b.id in (select (x ->> 'id')::uuid from jsonb_array_elements(v_plan) x);

  update public.settings set value = to_jsonb(p_to_id::text)
  where key = 'website_person_id' and value = to_jsonb(p_person_id::text);

  -- Widgets: the successor takes the member's place; if already a host there, the member just drops out.
  insert into public.booking_widget_hosts (widget_id, user_id)
  select widget_id, p_to_id from public.booking_widget_hosts where user_id = p_person_id
  on conflict do nothing;
  delete from public.booking_widget_hosts where user_id = p_person_id;

  update public.profiles set active = false where id = p_person_id;

  if not exists (select 1 from public.profiles where active and is_admin) then
    raise exception 'At least one active member must stay an admin.' using errcode = 'P0002';
  end if;
end;
$$;

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
  v_widget uuid := (p_booking ->> 'widget_id')::uuid;
  v_via public.booked_via := (p_booking ->> 'booked_via')::public.booked_via;
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
  -- The event type must still be on. FOR SHARE waits for a concurrent set_event_type_active (row update) and re-reads it.
  perform 1 from public.event_types et where et.id = v_event_type and et.active for share;
  if not found then
    raise exception 'This event type is no longer open for booking.' using errcode = 'P0006';
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

  -- Widget: still on, still this event type, host still one of its people. The row locks wait for a widget change.
  if v_widget is not null or v_via = 'widget' then
    perform 1
    from public.booking_widgets w
    join public.booking_widget_hosts h on h.widget_id = w.id and h.user_id = v_host
    where w.id = v_widget and w.active and w.event_type_id = v_event_type
    for share of w, h;
    if not found then
      raise exception 'The widget is no longer open for this booking.' using errcode = 'P0005';
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
    v_via,
    v_widget,
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
