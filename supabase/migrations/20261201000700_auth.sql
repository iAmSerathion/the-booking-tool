-- Sign-in: a profile for a Google user the app admits on first sign-in (allowed Workspace domain, or the initial admin).
-- The app's /auth/callback decides who is admitted; this function only makes "first admin" atomic.

-- Name and email come from auth.users (the email GoTrue verified), never from the caller. p_as_admin creates the
-- initial admin and fails with 42501 once any active admin exists. It takes the same 'team:admins' lock as the team
-- functions, so two first sign-ins at once cannot both become admin. 23505 = the user already has a profile.
-- Security definer to read auth.users; only the service role may call it.
create function public.admit_profile(p_id uuid, p_as_admin boolean) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_name text;
begin
  perform pg_advisory_xact_lock(hashtext('team:admins'));
  select
    lower(u.email),
    coalesce(nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''), nullif(btrim(u.raw_user_meta_data ->> 'name'), ''), split_part(u.email, '@', 1))
  into v_email, v_name
  from auth.users u
  where u.id = p_id;
  if coalesce(v_email, '') = '' then
    raise exception 'Unknown user or user without email.' using errcode = 'P0002';
  end if;
  if p_as_admin and exists (select 1 from public.profiles where active and is_admin) then
    raise exception 'An admin already exists.' using errcode = '42501';
  end if;
  insert into public.profiles (id, name, email, is_admin) values (p_id, v_name, v_email, p_as_admin);
end;
$$;

revoke execute on function public.admit_profile(uuid, boolean) from public, anon, authenticated;
grant execute on function public.admit_profile(uuid, boolean) to service_role;
