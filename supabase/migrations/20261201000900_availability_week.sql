-- Replace the caller's whole weekly availability in one transaction, so a failure never leaves the week half saved.
-- p_days is an array of seven window lists, Monday first: [[{"start": "09:00", "end": "17:00"}], [], ...].
-- Overlaps on any day are rejected with 23514; a wrong shape with 22023. Runs under the caller's RLS.
create function public.set_availability_week(p_days jsonb) returns void
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
  if jsonb_typeof(p_days) is distinct from 'array' or jsonb_array_length(p_days) <> 7
     or exists (select 1 from jsonb_array_elements(p_days) d where jsonb_typeof(d) is distinct from 'array') then
    raise exception 'Expected seven lists of windows.' using errcode = '22023';
  end if;

  delete from public.availability_windows where user_id = v_me;
  insert into public.availability_windows (user_id, weekday, start_time, end_time)
  select v_me, d.n::smallint, (w ->> 'start')::time, (w ->> 'end')::time
  from jsonb_array_elements(p_days) with ordinality as d(day, n)
  cross join lateral jsonb_array_elements(d.day) w;

  if exists (
    select 1
    from public.availability_windows a
    join public.availability_windows b
      on a.user_id = b.user_id and a.weekday = b.weekday and a.id <> b.id
     and a.start_time < b.end_time and b.start_time < a.end_time
    where a.user_id = v_me
  ) then
    raise exception 'The time windows overlap.' using errcode = '23514';
  end if;
end;
$$;

revoke execute on function public.set_availability_week(jsonb) from public, anon;
grant execute on function public.set_availability_week(jsonb) to authenticated;
