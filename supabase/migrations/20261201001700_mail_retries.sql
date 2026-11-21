-- Mail retries: the composed mail is stored with its row, so a retry sends exactly what the first attempt tried, even if
-- the code, the copy or the booking's host changed in between. next_attempt_at is the backoff (set by app code after a
-- failed attempt) and doubles as a short lease while an attempt runs. The scheduler claims due rows with
-- claim_mail_retries.

alter table public.outbound_mails
  add column body_html text,
  add column reply_to text,
  add column next_attempt_at timestamptz not null default now();

create index outbound_mails_retry_idx on public.outbound_mails (next_attempt_at) where state = 'pending';

-- Claim pending mails whose next attempt is due -------------------------------------------
-- First marks pending mails past send_until as failed, so they never stay pending. send_until is always judged by the
-- real clock (now()); p_now (a simulated clock in tests) only decides which attempts are due. FOR UPDATE SKIP LOCKED: two
-- concurrent runs take different rows; a claimed row is leased for p_lease_minutes, after which a later run may take it
-- again if the run died. p_only_booking: only this booking's mails (tests with a simulated clock); null means all.

create function public.claim_mail_retries(
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

revoke execute on function public.claim_mail_retries(timestamptz, integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_mail_retries(timestamptz, integer, integer, uuid) to service_role;
