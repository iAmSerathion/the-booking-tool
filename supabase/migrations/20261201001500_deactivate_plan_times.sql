-- deactivate_profile, again with two changes:
-- p_plan: {bookings: [{id, starts_at, ends_at, google_event_id, meet_url?}]}. A booking whose times differ from the
-- plan's makes it refuse (P0002): the successor's new event was created at the planned times, so a reschedule that
-- committed meanwhile (say after the server's booking lease ran out) would leave event and booking apart.
-- meet_url is taken as given, null included: the old link belonged to the departed member's event, which is deleted.

create or replace function public.deactivate_profile(p_person_id uuid, p_to_id uuid, p_actor_id uuid, p_plan jsonb) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_plan jsonb := coalesce(p_plan -> 'bookings', '[]'::jsonb);
begin
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
  perform pg_advisory_xact_lock(hashtext('team:admins'));
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
