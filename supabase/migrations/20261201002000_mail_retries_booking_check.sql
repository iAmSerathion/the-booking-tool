-- Mail retries must not outlive their booking: a reminder, confirmation or host notice that failed while SMTP was down
-- would otherwise still go out after the booking was cancelled, and a reminder or calendar move notice after a move would
-- show the old time.

-- Same as 20261201001700, plus a second sweep before the due select: pending booking mails are failed with last_error
-- 'booking no longer applies' when their booking is no longer booked (except the cancel notices themselves), and
-- reminder and calendar move mails also when the start in their send_key (its last segment, an ISO timestamp) is not the
-- booking's start any more.
create or replace function public.claim_mail_retries(
  p_now timestamptz,
  p_limit integer,
  p_lease_minutes integer,
  p_only_booking uuid default null
)
returns setof public.outbound_mails
language plpgsql
set search_path = ''
as $$
begin
  update public.outbound_mails
  set state = 'failed', last_error = 'expired'
  where state = 'pending'
    and send_until <= now()
    and (p_only_booking is null or booking_id = p_only_booking);

  update public.outbound_mails m
  set state = 'failed', last_error = 'booking no longer applies'
  from public.bookings b
  where b.id = m.booking_id
    and m.state = 'pending'
    and (p_only_booking is null or m.booking_id = p_only_booking)
    and (
      (b.state <> 'booked' and m.kind not in ('cancelled', 'cancelled_host'))
      or ((m.kind like 'reminder\_%' or m.kind = 'calendar_moved')
        and substring(m.send_key from '(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)$')::timestamptz is distinct from b.starts_at)
    );

  return query
  with due as (
    select id from public.outbound_mails
    where state = 'pending'
      and next_attempt_at <= p_now
      and (p_only_booking is null or booking_id = p_only_booking)
    order by next_attempt_at
    limit p_limit
    for update skip locked
  )
  update public.outbound_mails m
  set next_attempt_at = now() + make_interval(mins => p_lease_minutes)
  from due
  where m.id = due.id
  returning m.*;
end;
$$;
