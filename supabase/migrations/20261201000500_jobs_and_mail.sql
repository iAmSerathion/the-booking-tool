-- Jobs: scheduled reminder steps for bookings, and the mails the app sends.
-- When a step runs and whether it still applies is computed in app code; the scheduler claims due jobs (claim_due_jobs),
-- runs them and closes them (finish_job). Only service_role plans, claims and finishes, and only service_role reads or
-- writes both tables (RLS on, no policies).

create type public.booking_job_state as enum ('planned', 'done', 'cancelled', 'failed');

-- Booking jobs ------------------------------------------------------------------------------

create table public.booking_jobs (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  -- Free text set by app code (e.g. reminder_24h), so configurable reminders need no migration.
  step_key text not null,
  run_at timestamptz not null,
  -- Booking start the job was planned for: after a reschedule no reminder goes out for the old time.
  planned_for timestamptz not null,
  state public.booking_job_state not null default 'planned',
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  -- Set when a scheduler run claims the job; guards against double sends together with outbound_mails.send_key.
  claimed_at timestamptz,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index booking_jobs_due_idx on public.booking_jobs (run_at) where state = 'planned';
create index booking_jobs_booking_idx on public.booking_jobs (booking_id);

create trigger booking_jobs_updated_at before update on public.booking_jobs
  for each row execute function public.set_updated_at();

-- Outbound mails ----------------------------------------------------------------------------
-- One row per mail, written before sending. send_key makes each occasion send at most once (a duplicate insert fails
-- with 23505). send_until: after this time the mail is no longer sent or retried (e.g. a reminder after the start).
-- Sender and reply-to are derived at send time (host of the booking), so no sender column.

create type public.outbound_mail_state as enum ('pending', 'sent', 'failed');

create table public.outbound_mails (
  id uuid primary key default gen_random_uuid(),
  send_key text not null unique,
  -- Nullable so mails without a booking (e.g. a team invite) use the same send path.
  booking_id uuid references public.bookings (id) on delete cascade,
  -- What the mail is, e.g. confirmation, reminder_24h, host_notification.
  kind text not null,
  "to" text[] not null default '{}',
  subject text not null default '',
  body_text text not null default '',
  state public.outbound_mail_state not null default 'pending',
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  send_until timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index outbound_mails_booking_idx on public.outbound_mails (booking_id, created_at);

-- Row level security -----------------------------------------------------------------------

alter table public.booking_jobs enable row level security;
alter table public.outbound_mails enable row level security;

-- Explicit, because Supabase default privileges grant everything on new public tables to anon and authenticated.
revoke all on public.booking_jobs, public.outbound_mails from anon, authenticated;
grant select, insert, update, delete on public.booking_jobs, public.outbound_mails to service_role;

-- Plan the jobs of a booking (after booking, rescheduling, calendar move) ------------------
-- p_jobs: [{step_key, run_at}]. Open jobs of the booking are cancelled; the new ones apply to the booking's current start.
-- Returns the number of jobs planned (0 if the booking is no longer booked).

create function public.plan_booking_jobs(p_booking_id uuid, p_jobs jsonb) returns integer
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

-- Cancel open jobs when a booking is cancelled or moved ------------------------------------
-- Security definer: cancel_booking_as_host runs as a member, who has no rights on booking_jobs. Also fires when starts_at
-- changes, so stale reminders die in the reschedule transaction even if the app's re-plan afterwards fails.

create function public.bookings_cancel_jobs() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.booking_jobs
  set state = 'cancelled',
      last_error = case when new.state <> 'booked' then 'booking ' || new.state::text else 'booking rescheduled' end
  where booking_id = new.id and state = 'planned';
  return new;
end;
$$;

create trigger bookings_cancel_jobs after update of state, starts_at on public.bookings
  for each row
  when (old.state = 'booked' and (new.state <> 'booked' or new.starts_at is distinct from old.starts_at))
  execute function public.bookings_cancel_jobs();

-- Claim due jobs (scheduler) ---------------------------------------------------------------
-- FOR UPDATE SKIP LOCKED: two concurrent runs take different jobs. A claimed job counts as in progress for p_claim_minutes
-- (against the real clock); if the run dies, a later run takes it again (send_key prevents a double send).
-- p_only_booking: only this booking's jobs (tests with a simulated clock); null means all.

create function public.claim_due_jobs(
  p_now timestamptz,
  p_limit integer,
  p_claim_minutes integer,
  p_only_booking uuid default null
)
returns setof public.booking_jobs
language sql
set search_path = ''
as $$
  with due as (
    select id from public.booking_jobs
    where state = 'planned'
      and run_at <= p_now
      and (claimed_at is null or claimed_at < now() - make_interval(mins => p_claim_minutes))
      and (p_only_booking is null or booking_id = p_only_booking)
    order by run_at
    limit p_limit
    for update skip locked
  )
  update public.booking_jobs j
  set claimed_at = now(), attempts = j.attempts + 1
  from due
  where j.id = due.id
  returning j.*;
$$;

-- Finish a job: done, cancelled (no longer applies), failed, or planned again after an error (retry). Only while it is
-- still planned, so a job cancelled meanwhile stays cancelled.

create function public.finish_job(p_job_id uuid, p_state public.booking_job_state, p_error text) returns void
language sql
set search_path = ''
as $$
  update public.booking_jobs
  set state = p_state,
      done_at = case when p_state = 'done' then now() end,
      last_error = p_error,
      claimed_at = null
  where id = p_job_id and state = 'planned';
$$;

-- Function grants: service_role only (Supabase grants new functions to anon and authenticated).
revoke execute on function public.plan_booking_jobs(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.bookings_cancel_jobs() from public, anon, authenticated;
revoke execute on function public.claim_due_jobs(timestamptz, integer, integer, uuid) from public, anon, authenticated;
revoke execute on function public.finish_job(uuid, public.booking_job_state, text) from public, anon, authenticated;

grant execute on function public.plan_booking_jobs(uuid, jsonb) to service_role;
grant execute on function public.claim_due_jobs(timestamptz, integer, integer, uuid) to service_role;
grant execute on function public.finish_job(uuid, public.booking_job_state, text) to service_role;
