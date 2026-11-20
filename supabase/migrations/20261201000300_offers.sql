-- Offers: what can be booked (event types) and through which entry points (widgets, single-invitee links).
-- Members read; writes go through the security-definer functions below. Public pages read with service_role.

-- Event types ------------------------------------------------------------------------------

-- Booking questions: [{id, label, type: 'choice'|'multi'|'text', choices: [text], required: bool}], at most 20, unique ids.
-- Checked in the table because the questions drive the public form and answer validation.
create function public.event_type_questions_valid(p jsonb) returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(pg_catalog.jsonb_typeof(p), '') <> 'array' then false
    when pg_catalog.jsonb_array_length(p) > 20 then false
    else
      not exists (
        select 1 from pg_catalog.jsonb_array_elements(p) as q
        where case
          when pg_catalog.jsonb_typeof(q) <> 'object' then true
          when coalesce(q ->> 'id', '') !~ '^[a-z][a-z0-9_-]{0,39}$' then true
          when pg_catalog.char_length(pg_catalog.btrim(coalesce(q ->> 'label', ''))) not between 1 and 200 then true
          when coalesce(q ->> 'type', '') not in ('choice', 'multi', 'text') then true
          when q ? 'required' and pg_catalog.jsonb_typeof(q -> 'required') <> 'boolean' then true
          when q ->> 'type' = 'text' then false
          when pg_catalog.jsonb_typeof(q -> 'choices') is distinct from 'array' then true
          when pg_catalog.jsonb_array_length(q -> 'choices') not between 1 and 30 then true
          else exists (
            select 1 from pg_catalog.jsonb_array_elements(q -> 'choices') as c
            where pg_catalog.jsonb_typeof(c) <> 'string'
              or pg_catalog.char_length(pg_catalog.btrim(c #>> '{}')) not between 1 and 200
          )
        end
      )
      and (select count(distinct q ->> 'id') = count(*) from pg_catalog.jsonb_array_elements(p) as q)
  end;
$$;

create table public.event_types (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 60),
  title text not null check (btrim(title) <> '' and char_length(title) <= 120),
  description text check (description is null or char_length(description) <= 2000),
  duration_minutes integer not null check (duration_minutes between 5 and 480 and duration_minutes % 5 = 0),
  questions jsonb not null default '[]'::jsonb check (public.event_type_questions_valid(questions)),
  active boolean not null default true,
  created_by uuid references public.profiles (id),
  updated_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger event_types_updated_at before update on public.event_types
  for each row execute function public.set_updated_at();

-- Booking widgets --------------------------------------------------------------------------
-- The id is public in the embed snippet and random (gen_random_uuid), so it cannot be guessed. Nothing is deleted;
-- "inactive" replaces deletion.

-- Origins that may embed a widget (CSP frame-ancestors): https://host[:port] with a dotted host, lowercase, no path,
-- at most 20. Plain http only for localhost and 127.0.0.1, so local development and e2e can embed.
create function public.embed_origins_valid(p text[]) returns boolean
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.cardinality(p) <= 20 and not exists (
    select 1 from pg_catalog.unnest(p) as o
    where o is null
      or o !~ '^(https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+|http://(localhost|127\.0\.0\.1))(:[0-9]{1,5})?$'
  );
$$;

create table public.booking_widgets (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> '' and char_length(name) <= 80),
  mode text not null default 'person' check (mode in ('person', 'round_robin')),
  event_type_id uuid not null references public.event_types (id),
  allowed_origins text[] not null default '{}' check (public.embed_origins_valid(allowed_origins)),
  active boolean not null default true,
  created_by uuid references public.profiles (id),
  updated_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger booking_widgets_updated_at before update on public.booking_widgets
  for each row execute function public.set_updated_at();

-- Who is booked through a widget: exactly one row for 'person', the selection for 'round_robin'.
create table public.booking_widget_hosts (
  widget_id uuid not null references public.booking_widgets (id) on delete cascade,
  user_id uuid not null references public.profiles (id),
  primary key (widget_id, user_id)
);

create index booking_widget_hosts_user_idx on public.booking_widget_hosts (user_id);

-- Booking links ----------------------------------------------------------------------------
-- A link for one invitee with a fixed host: only the sha256 hex of the token is stored. Every "copy link" creates a new
-- row; older links stay valid unless single_use (then used_at closes it) or expires_at has passed. create_booking checks
-- both under the host lock and sets used_at; it also rejects links whose host is no longer active and bookable.

create table public.booking_links (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  host_id uuid not null references public.profiles (id),
  event_type_id uuid not null references public.event_types (id),
  -- Invitee fields shown prefilled (name, email, company, answers ...). Size-capped: members write it directly.
  prefill jsonb not null default '{}'::jsonb check (jsonb_typeof(prefill) = 'object' and pg_column_size(prefill) <= 8192),
  -- Opaque caller data, passed through to webhooks.
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 8192),
  single_use boolean not null default false,
  used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at is null or expires_at > created_at)
);

create index booking_links_host_idx on public.booking_links (host_id);

-- Row level security -----------------------------------------------------------------------

alter table public.event_types enable row level security;
alter table public.booking_widgets enable row level security;
alter table public.booking_widget_hosts enable row level security;
alter table public.booking_links enable row level security;

create policy "Members read event types" on public.event_types
  for select to authenticated using ((select public.is_active_profile()));
create policy "Members read widgets" on public.booking_widgets
  for select to authenticated using ((select public.is_active_profile()));
create policy "Members read widget hosts" on public.booking_widget_hosts
  for select to authenticated using ((select public.is_active_profile()));

create policy "Hosts and admins read booking links" on public.booking_links
  for select to authenticated
  using ((select public.is_active_profile()) and (host_id = (select auth.uid()) or (select public.is_admin())));
-- Links point at an active, bookable host and an active event type; admins may create links for other hosts.
create policy "Members create links for themselves, admins for any host" on public.booking_links
  for insert to authenticated
  with check (
    (select public.is_active_profile())
    and (host_id = (select auth.uid()) or (select public.is_admin()))
    and exists (select 1 from public.profiles p where p.id = host_id and p.active and p.bookable)
    and exists (select 1 from public.event_types e where e.id = event_type_id and e.active)
  );

-- Explicit, because Supabase default privileges grant everything on new public tables to anon and authenticated.
revoke all on public.event_types, public.booking_widgets, public.booking_widget_hosts, public.booking_links from anon, authenticated;
grant select on public.event_types, public.booking_widgets, public.booking_widget_hosts, public.booking_links to authenticated;
-- Column grant: members cannot set id, used_at or created_at.
grant insert (token_hash, host_id, event_type_id, prefill, metadata, single_use, expires_at) on public.booking_links to authenticated;
grant select, insert, update, delete on public.event_types, public.booking_widgets, public.booking_widget_hosts, public.booking_links
  to service_role;

-- Event types: create (p_id null) and update -----------------------------------------------
-- Error codes as in the widget functions: 23514 and P0002 carry a message for the user, 42501 means "no right".

create function public.save_event_type(
  p_id uuid, p_slug text, p_title text, p_description text, p_duration_minutes integer, p_questions jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := p_id;
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_title text := btrim(coalesce(p_title, ''));
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
  v_questions jsonb := coalesce(p_questions, '[]'::jsonb);
begin
  perform public.assert_is_admin();
  if v_title = '' or char_length(v_title) > 120 then
    raise exception 'Please give the event type a title of at most 120 characters.' using errcode = '23514';
  end if;
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_slug) > 60 then
    raise exception 'The link name may only contain lowercase letters, digits and single dashes (at most 60).' using errcode = '23514';
  end if;
  if char_length(v_description) > 2000 then
    raise exception 'The description may have at most 2000 characters.' using errcode = '23514';
  end if;
  if p_duration_minutes is null or p_duration_minutes not between 5 and 480 or p_duration_minutes % 5 <> 0 then
    raise exception 'The duration must be between 5 and 480 minutes, in steps of 5.' using errcode = '23514';
  end if;
  if not public.event_type_questions_valid(v_questions) then
    raise exception 'The questions are not valid.' using errcode = '23514';
  end if;
  if exists (select 1 from public.event_types where slug = v_slug and id is distinct from v_id) then
    raise exception 'Another event type already uses this link name.' using errcode = '23514';
  end if;

  if v_id is null then
    insert into public.event_types (slug, title, description, duration_minutes, questions, created_by, updated_by)
    values (v_slug, v_title, v_description, p_duration_minutes, v_questions, (select auth.uid()), (select auth.uid()))
    returning id into v_id;
  else
    update public.event_types
    set slug = v_slug, title = v_title, description = v_description, duration_minutes = p_duration_minutes,
        questions = v_questions, updated_by = (select auth.uid())
    where id = v_id;
    if not found then
      raise exception 'This event type does not exist.' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end;
$$;

-- On and off. The default event type stays on, so the booking page always has something to offer.
create function public.set_event_type_active(p_id uuid, p_active boolean) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_is_admin();
  if not coalesce(p_active, false)
     and exists (select 1 from public.settings where key = 'default_event_type_id' and value = to_jsonb(p_id::text)) then
    raise exception 'The default event type cannot be switched off.' using errcode = '23514';
  end if;
  update public.event_types set active = coalesce(p_active, false), updated_by = (select auth.uid()) where id = p_id;
  if not found then
    raise exception 'This event type does not exist.' using errcode = 'P0002';
  end if;
end;
$$;

-- Widgets: create (p_id null) and update. Mirrors the widget form validation in the app. ----

create function public.save_booking_widget(
  p_id uuid, p_name text, p_mode text, p_host_ids uuid[], p_event_type_id uuid, p_allowed_origins text[]
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := p_id;
  v_name text := btrim(coalesce(p_name, ''));
  v_hosts uuid[] := array(select distinct x from unnest(coalesce(p_host_ids, '{}'::uuid[])) as x);
  v_origins text[] := array(
    select distinct lower(rtrim(btrim(o), '/')) from unnest(coalesce(p_allowed_origins, '{}'::text[])) as o
    where btrim(o) <> '' order by 1
  );
begin
  perform public.assert_is_admin();
  if v_name = '' then
    raise exception 'Please give the widget a name.' using errcode = '23514';
  end if;
  if p_mode is null or p_mode not in ('person', 'round_robin') then
    raise exception 'Unknown mode.' using errcode = '22023';
  end if;
  if cardinality(v_hosts) = 0 or (p_mode = 'person' and cardinality(v_hosts) <> 1) then
    raise exception 'Please choose one person, or at least one for round robin.' using errcode = '23514';
  end if;
  if exists (
    select 1 from unnest(v_hosts) as x
    where not exists (select 1 from public.profiles p where p.id = x and p.active and p.bookable)
  ) then
    raise exception 'This person cannot be booked.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.event_types where id = p_event_type_id and active) then
    raise exception 'This event type no longer exists.' using errcode = 'P0002';
  end if;
  if not public.embed_origins_valid(v_origins) then
    raise exception 'Allowed sites must be origins such as https://www.example.com (at most 20).' using errcode = '23514';
  end if;

  if v_id is null then
    insert into public.booking_widgets (name, mode, event_type_id, allowed_origins, created_by, updated_by)
    values (left(v_name, 80), p_mode, p_event_type_id, v_origins, (select auth.uid()), (select auth.uid()))
    returning id into v_id;
  else
    update public.booking_widgets
    set name = left(v_name, 80), mode = p_mode, event_type_id = p_event_type_id, allowed_origins = v_origins,
        updated_by = (select auth.uid())
    where id = v_id;
    if not found then
      raise exception 'This widget does not exist.' using errcode = 'P0002';
    end if;
    delete from public.booking_widget_hosts where widget_id = v_id;
  end if;
  insert into public.booking_widget_hosts (widget_id, user_id) select v_id, x from unnest(v_hosts) as x;
  return v_id;
end;
$$;

-- On and off. An inactive widget shows invitees a notice instead of the booking.
create function public.set_booking_widget_active(p_id uuid, p_active boolean) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_is_admin();
  update public.booking_widgets set active = coalesce(p_active, false), updated_by = (select auth.uid()) where id = p_id;
  if not found then
    raise exception 'This widget does not exist.' using errcode = 'P0002';
  end if;
end;
$$;

-- Website default (the general booking page): one person, or round robin among all bookable members.
create function public.set_website_bookings(p_mode text, p_person_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_is_admin();
  if p_mode is null or p_mode not in ('person', 'round_robin') then
    raise exception 'Unknown mode.' using errcode = '22023';
  end if;
  if p_mode = 'person' and not exists (select 1 from public.profiles where id = p_person_id and active and bookable) then
    raise exception 'This person cannot be booked.' using errcode = 'P0002';
  end if;
  if p_mode = 'round_robin' and not exists (select 1 from public.profiles where active and bookable) then
    raise exception 'Nobody can be booked.' using errcode = 'P0002';
  end if;
  insert into public.settings (key, value) values ('website_mode', to_jsonb(p_mode))
  on conflict (key) do update set value = excluded.value;
  if p_mode = 'person' then
    insert into public.settings (key, value) values ('website_person_id', to_jsonb(p_person_id::text))
    on conflict (key) do update set value = excluded.value;
  end if;
end;
$$;

revoke execute on function public.save_event_type(uuid, text, text, text, integer, jsonb) from public, anon;
revoke execute on function public.set_event_type_active(uuid, boolean) from public, anon;
revoke execute on function public.save_booking_widget(uuid, text, text, uuid[], uuid, text[]) from public, anon;
revoke execute on function public.set_booking_widget_active(uuid, boolean) from public, anon;
revoke execute on function public.set_website_bookings(text, uuid) from public, anon;
grant execute on function public.save_event_type(uuid, text, text, text, integer, jsonb) to authenticated;
grant execute on function public.set_event_type_active(uuid, boolean) to authenticated;
grant execute on function public.save_booking_widget(uuid, text, text, uuid[], uuid, text[]) to authenticated;
grant execute on function public.set_booking_widget_active(uuid, boolean) to authenticated;
grant execute on function public.set_website_bookings(text, uuid) to authenticated;

-- Start content: one generic event type as the default, so a fresh install can take bookings.
-- website_mode is seeded in the base migration.
with t as (
  insert into public.event_types (slug, title, duration_minutes) values ('meeting', 'Meeting', 30) returning id
)
insert into public.settings (key, value) select 'default_event_type_id', to_jsonb(id::text) from t
on conflict (key) do nothing;
