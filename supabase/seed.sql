-- Local development and test data. Runs once after the migrations on `supabase db reset` (and in scripts/db-test.sh).
-- Example data only (example.com). Fixed ids so tests and docs can refer to them:
--   00000000-0000-4000-8000-000000000001  admin member  admin.demo@example.com (not bookable)
--   00000000-0000-4000-8000-000000000002  host member   host.demo@example.com  (bookable, page /demo-host)
--   00000000-0000-4000-8000-000000000101  event type    discovery-call (30 min, one question)
--   00000000-0000-4000-8000-000000000201  widget        "Example site", person mode, embeddable on https://example.com
-- No bookings. Login is Google OAuth; these users have no password (e2e signs in with generated magic links), and
-- nobody can receive mail or own a Google account at example.com, so they cannot be signed in to by hand.
-- Development only: never apply this to a real install (`supabase db push` leaves it out unless --include-seed). Its
-- active admin would stop INITIAL_ADMIN_EMAIL from creating the first real admin.

-- Members: auth users first, then profiles. The profiles insert trigger adds the default availability windows
-- (Monday to Friday, 09:00-12:00 and 14:00-17:00, from settings.default_availability).
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'admin.demo@example.com', '{"provider": "email", "providers": ["email"]}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'host.demo@example.com', '{"provider": "email", "providers": ["email"]}', '{}', now(), now())
on conflict (id) do nothing;

-- GoTrue fails to load users whose token columns are null, and needs a confirmed email. Column sets differ between
-- the GoTrue schema and the bare Postgres image used by scripts/db-test.sh, so only touch columns that exist.
do $$
declare
  v_column text;
begin
  foreach v_column in array array['confirmation_token', 'recovery_token', 'email_change_token_new', 'email_change'] loop
    if exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = v_column) then
      execute format('update auth.users set %1$I = coalesce(%1$I, %2$L) where id in (%3$L, %4$L)', v_column, '',
        '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002');
    end if;
  end loop;
  if exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'email_confirmed_at') then
    update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now())
    where id in ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002');
  end if;
end;
$$;

insert into public.profiles (id, name, email, slug, timezone, is_admin, bookable)
values
  ('00000000-0000-4000-8000-000000000001', 'Demo Admin', 'admin.demo@example.com', null, 'Europe/Berlin', true, false),
  ('00000000-0000-4000-8000-000000000002', 'Demo Host', 'host.demo@example.com', 'demo-host', 'Europe/Berlin', false, true)
on conflict (id) do nothing;

-- Event type with one booking question, next to the default "meeting" event type from the migrations.
insert into public.event_types (id, slug, title, description, duration_minutes, questions, created_by, updated_by)
values (
  '00000000-0000-4000-8000-000000000101', 'discovery-call', 'Discovery call', 'A short first call to get to know each other.', 30,
  '[{"id": "topic", "label": "What would you like to talk about?", "type": "choice", "choices": ["Getting started", "Pricing", "Something else"], "required": true}]',
  '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'
)
on conflict (id) do nothing;

-- Widget for the host, embeddable on https://example.com.
insert into public.booking_widgets (id, name, mode, event_type_id, allowed_origins, created_by, updated_by)
values (
  '00000000-0000-4000-8000-000000000201', 'Example site', 'person', '00000000-0000-4000-8000-000000000101',
  '{https://example.com}', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'
)
on conflict (id) do nothing;

insert into public.booking_widget_hosts (widget_id, user_id)
values ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000002')
on conflict do nothing;

-- Settings: the migrations seed slot_horizon_days, website_mode (round robin), default_event_type_id and
-- default_availability. The brand is set here so local pages show a neutral name instead of the env fallback.
insert into public.settings (key, value)
values ('brand', '{"name": "Example Team", "logo_url": null}')
on conflict (key) do nothing;
