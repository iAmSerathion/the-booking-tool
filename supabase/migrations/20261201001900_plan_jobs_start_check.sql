-- plan_booking_jobs takes the start the run_at values were computed from. If the booking moved between the app's read
-- and this call (a calendar sync and a reschedule re-planning at once), the jobs would carry the old run_at but the new
-- planned_for, and the run check would let a reminder at the wrong time through. Then nothing is changed: the open jobs
-- were planned by whoever moved the booking last.

drop function public.plan_booking_jobs(uuid, jsonb);

-- p_jobs: [{step_key, run_at}], computed from p_starts_at. Open jobs of the booking are cancelled; the new ones apply to
-- the booking's current start. Returns the number of jobs planned: 0 if the booking is no longer booked, or if it no
-- longer starts at p_starts_at (then its open jobs stay).
create function public.plan_booking_jobs(p_booking_id uuid, p_jobs jsonb, p_starts_at timestamptz) returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
  v_count integer;
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  if v_booking.state = 'booked' and v_booking.starts_at is distinct from p_starts_at then
    return 0;
  end if;

  update public.booking_jobs set state = 'cancelled', last_error = 'replanned'
  where booking_id = p_booking_id and state = 'planned';

  if v_booking.state <> 'booked' then
    return 0;
  end if;

  insert into public.booking_jobs (booking_id, step_key, run_at, planned_for)
  select p_booking_id, j ->> 'step_key', (j ->> 'run_at')::timestamptz, v_booking.starts_at
  from jsonb_array_elements(p_jobs) as j;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.plan_booking_jobs(uuid, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.plan_booking_jobs(uuid, jsonb, timestamptz) to service_role;
