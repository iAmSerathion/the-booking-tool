-- Team: member rights, invite, deactivate (hand over to a successor) and reactivate. No tables of its own.
-- Rule shared by all of them: at least one active admin must remain. The advisory lock 'team:admins' serialises every
-- change that can remove an admin, so two admins demoting or deactivating each other at once cannot leave none.
-- Error codes: 42501 = not an admin, P0002 = refusal with a message for the user, 23505 = duplicate email or slug,
-- 23514 = invalid input.

-- The outbox also tells integrations when a booking gets a new host.
alter table public.booking_outbox drop constraint booking_outbox_type_check;
alter table public.booking_outbox add constraint booking_outbox_type_check
  check (type in ('booking.created', 'booking.rescheduled', 'booking.cancelled', 'booking.host_changed'));

-- Rights of a member. p_rights: {is_admin?, bookable?}; only the keys present change.
create function public.set_person_rights(p_person_id uuid, p_rights jsonb) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_is_admin();
  perform pg_advisory_xact_lock(hashtext('team:admins'));
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

-- Back in: nothing is handed back.
create function public.reactivate_profile(p_person_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_is_admin();
  update public.profiles set active = true where id = p_person_id and not active;
  if not found then
    raise exception 'This member is already active.' using errcode = 'P0002';
  end if;
end;
$$;

-- Invite: server code creates the auth user with the service key first, then calls this; on error it deletes that user.
-- p_profile: {name, email, slug?, is_admin?, bookable?}. Starting availability comes from the profiles insert trigger.
-- bookable defaults to false: a new member has no calendar connected yet.
-- Service role only, so the actor comes in as p_actor_id (auth.uid() is null under the service key).
create function public.invite_profile(p_id uuid, p_actor_id uuid, p_profile jsonb) returns void
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and active and is_admin) then
    raise exception 'Only admins can change this.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_profile ->> 'name'), '') = '' or coalesce(btrim(p_profile ->> 'email'), '') = '' then
    raise exception 'Name and email are required.' using errcode = '23514';
  end if;
  insert into public.profiles (id, name, email, slug, is_admin, bookable)
  values (
    p_id,
    btrim(p_profile ->> 'name'),
    lower(btrim(p_profile ->> 'email')),
    nullif(btrim(p_profile ->> 'slug'), ''),
    coalesce((p_profile ->> 'is_admin')::boolean, false),
    coalesce((p_profile ->> 'bookable')::boolean, false)
  );
end;
$$;

-- Deactivate and hand over to a successor (p_to_id): future bookings, widget hosts and the website default person.
-- Server code first creates the events in the successor's calendar, calls this with the new event ids, then deletes the
-- old events (so the old host's calendar sync no longer finds the booking). If this fails it deletes the new events.
-- p_plan: {bookings: [{id, google_event_id, meet_url?}]}, exactly the host's future booked bookings.
-- Booking links of the member are not moved: create_booking rejects links of inactive hosts. The successor's own
-- bookings are not checked for overlaps; server code can warn before calling this.
create function public.deactivate_profile(p_person_id uuid, p_to_id uuid, p_actor_id uuid, p_plan jsonb) returns void
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

  -- The plan was built before the calendar calls; refuse if the host's future bookings changed since. Server code
  -- removes the new events and retries.
  if exists (
    select 1 from public.bookings b
    where b.host_id = p_person_id and b.state = 'booked' and b.starts_at > now()
      and not exists (select 1 from jsonb_array_elements(v_plan) x where (x ->> 'id')::uuid = b.id)
  ) or exists (
    select 1 from jsonb_array_elements(v_plan) x
    where not exists (
      select 1 from public.bookings b where b.id = (x ->> 'id')::uuid and b.host_id = p_person_id and b.state = 'booked'
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
    meet_url = coalesce(p.meet_url, b.meet_url),
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

-- Supabase grants new functions to anon and authenticated; set them explicitly.
revoke execute on function public.set_person_rights(uuid, jsonb) from public, anon;
revoke execute on function public.reactivate_profile(uuid) from public, anon;
revoke execute on function public.invite_profile(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.deactivate_profile(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_person_rights(uuid, jsonb) to authenticated;
grant execute on function public.reactivate_profile(uuid) to authenticated;
grant execute on function public.invite_profile(uuid, uuid, jsonb) to service_role;
grant execute on function public.deactivate_profile(uuid, uuid, uuid, jsonb) to service_role;
