-- hold_slot under concurrency: live holds count toward the daily maximum, and the buffer also separates a new hold from
-- other live holds. Both checks run under the per-host advisory lock, so two invitees racing through the Google insert
-- cannot exceed max_bookings_per_day or book back to back inside buffer_minutes. Same signature, so grants stay.

create or replace function public.hold_slot(
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
    where h.host_id = p_host_id
      and h.starts_at - v_buffer < p_ends_at
      and h.ends_at + v_buffer > p_starts_at
  ) then
    return null;
  end if;

  -- Booked bookings plus live holds (expired ones are deleted above) of that day.
  if (
    select count(*) from public.bookings b
    where b.state = 'booked'
      and b.id is distinct from p_except_booking
      and b.host_id = p_host_id
      and b.starts_at >= p_day_from and b.starts_at < p_day_to
  ) + (
    select count(*) from public.slot_holds h
    where h.host_id = p_host_id
      and h.starts_at >= p_day_from and h.starts_at < p_day_to
  ) >= p_max_per_day then
    return null;
  end if;

  insert into public.slot_holds (host_id, starts_at, ends_at)
  values (p_host_id, p_starts_at, p_ends_at)
  returning id into v_hold;
  return v_hold;
end;
$$;
