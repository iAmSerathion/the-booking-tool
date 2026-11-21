-- Outbound webhooks from booking_outbox (lib/events/dispatcher.ts, run by the scheduler).
-- A row is pending while delivered_at and given_up_at are both null. next_attempt_at is the backoff (set by app code after
-- a failed attempt) and doubles as a short lease while an attempt runs, as with mail retries. A row is given up after its
-- last retry, when it is older than 72 hours, or when no WEBHOOK_URL is configured; last_error says why. Delivered and
-- given-up rows are deleted after 30 days, since payloads hold the invitee's personal data.

alter table public.booking_outbox add column given_up_at timestamptz;

drop index public.booking_outbox_due_idx;
create index booking_outbox_pending_idx on public.booking_outbox (next_attempt_at) where delivered_at is null and given_up_at is null;
create index booking_outbox_booking_order_idx on public.booking_outbox (booking_id, created_at, id) where delivered_at is null and given_up_at is null;
create index booking_outbox_created_idx on public.booking_outbox (created_at);

-- Payload ----------------------------------------------------------------------------------
-- The shape a webhook consumer sees (README "Webhooks"), the same for every event type and writer, plus the event's own
-- keys from p_extra (previous, changed_by, reason, previous_host_id). Before this it was the raw bookings row, which
-- carried internal columns (google_event_id) and no host or event type details. Same signature, so grants and every
-- caller (create, reschedule, cancel, calendar sync, deactivation hand-over) stay.
create or replace function public.booking_event_payload(p_booking public.bookings, p_extra jsonb default '{}'::jsonb) returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_booking.id,
    'state', p_booking.state,
    'cancelled_by', p_booking.cancelled_by,
    'starts_at', p_booking.starts_at,
    'ends_at', p_booking.ends_at,
    'host', (select jsonb_build_object('id', p.id, 'name', p.name, 'email', p.email::text) from public.profiles p where p.id = p_booking.host_id),
    'attendee', jsonb_build_object(
      'name', p_booking.invitee_name,
      'email', p_booking.invitee_email::text,
      'company', p_booking.invitee_company,
      'phone', p_booking.invitee_phone,
      'timezone', p_booking.invitee_timezone),
    'topic', p_booking.topic,
    'answers', p_booking.answers,
    'event_type', (select jsonb_build_object('id', e.id, 'slug', e.slug, 'title', e.title) from public.event_types e where e.id = p_booking.event_type_id),
    'booked_via', p_booking.booked_via,
    'widget_id', p_booking.widget_id,
    'booking_page', p_booking.booking_page,
    'link', (select jsonb_build_object('id', l.id, 'metadata', l.metadata) from public.booking_links l where l.id = p_booking.link_id),
    'meet_url', p_booking.meet_url,
    'reschedule_count', p_booking.reschedule_count,
    'created_at', p_booking.created_at
  ) || coalesce(p_extra, '{}'::jsonb);
$$;

-- Claim due outbox rows --------------------------------------------------------------------
-- Housekeeping first, judged by the real clock (now()): deletes delivered and given-up rows older than 30 days, gives up
-- pending rows older than 72 hours ('expired'). Without a webhook (p_configured false) due rows are given up ('not
-- configured') and nothing is returned, so turning webhooks on later does not replay old history.
-- Then claims due rows, oldest first, but only a booking's oldest pending row: a newer event of a booking waits until every
-- older one is delivered or given up, so a consumer sees created -> rescheduled -> cancelled in order. FOR UPDATE SKIP
-- LOCKED: concurrent runs take different rows. A claimed row is leased for p_lease_minutes from the later of now() and
-- p_now (a simulated clock in tests), so the same run never sees it due again. p_only_booking: only this booking's rows
-- (tests with a simulated clock); null means all.
create function public.claim_booking_outbox(
  p_now timestamptz,
  p_limit integer,
  p_lease_minutes integer,
  p_only_booking uuid default null,
  p_configured boolean default true
)
returns setof public.booking_outbox
language plpgsql
set search_path = ''
as $$
begin
  delete from public.booking_outbox
  where created_at < now() - interval '30 days'
    and (delivered_at is not null or given_up_at is not null)
    and (p_only_booking is null or booking_id = p_only_booking);

  update public.booking_outbox
  set given_up_at = now(), last_error = 'expired'
  where delivered_at is null and given_up_at is null
    and created_at < now() - interval '72 hours'
    and (p_only_booking is null or booking_id = p_only_booking);

  if not p_configured then
    update public.booking_outbox
    set given_up_at = now(), last_error = 'not configured'
    where delivered_at is null and given_up_at is null
      and next_attempt_at <= p_now
      and (p_only_booking is null or booking_id = p_only_booking);
    return;
  end if;

  return query
  with due as (
    select o.id from public.booking_outbox o
    where o.delivered_at is null and o.given_up_at is null
      and o.next_attempt_at <= p_now
      and (p_only_booking is null or o.booking_id = p_only_booking)
      and not exists (
        select 1 from public.booking_outbox e
        where e.booking_id = o.booking_id
          and e.delivered_at is null and e.given_up_at is null
          and (e.created_at, e.id) < (o.created_at, o.id)
      )
    order by o.created_at, o.id
    limit p_limit
    for update skip locked
  )
  update public.booking_outbox o
  set next_attempt_at = greatest(now(), p_now) + make_interval(mins => p_lease_minutes)
  from due
  where o.id = due.id
  returning o.*;
end;
$$;

revoke execute on function public.claim_booking_outbox(timestamptz, integer, integer, uuid, boolean) from public, anon, authenticated;
grant execute on function public.claim_booking_outbox(timestamptz, integer, integer, uuid, boolean) to service_role;

-- Rows written before this migration carry the old raw-bookings payload, which consumers must never see: give them up.
update public.booking_outbox
set given_up_at = now(), last_error = 'old payload'
where delivered_at is null and given_up_at is null;
