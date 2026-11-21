-- Default event type: admins choose which active event type "/" and "/<slug>" book when no ?type= is given.
-- settings stays service_role write only; this security-definer function is the one writer of default_event_type_id.
-- Both functions lock the event type row first, so a concurrent "make default" and "switch off" of the same type
-- cannot leave the default switched off (which would turn "/" into the 404 page).

create function public.set_default_event_type(p_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_is_admin();
  perform 1 from public.event_types where id = p_id and active for update;
  if not found then
    raise exception 'This event type does not exist or is switched off.' using errcode = 'P0002';
  end if;
  insert into public.settings (key, value) values ('default_event_type_id', to_jsonb(p_id::text))
  on conflict (key) do update set value = excluded.value;
end;
$$;

revoke execute on function public.set_default_event_type(uuid) from public, anon;
grant execute on function public.set_default_event_type(uuid) to authenticated;

-- set_event_type_active as in 20261201000300_offers.sql, plus the row lock before the default check. Same signature,
-- so the grants stay.
create or replace function public.set_event_type_active(p_id uuid, p_active boolean) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_is_admin();
  perform 1 from public.event_types where id = p_id for update;
  if not found then
    raise exception 'This event type does not exist.' using errcode = 'P0002';
  end if;
  if not coalesce(p_active, false)
     and exists (select 1 from public.settings where key = 'default_event_type_id' and value = to_jsonb(p_id::text)) then
    raise exception 'The default event type cannot be switched off.' using errcode = '23514';
  end if;
  update public.event_types set active = coalesce(p_active, false), updated_by = (select auth.uid()) where id = p_id;
end;
$$;
