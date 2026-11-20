-- Reconnecting with another Google account must not keep the old account's calendars.

-- Same as before, plus: when the account email changes, busy calendars restart from the new primary calendar, the sync
-- state is dropped (a sync token belongs to one calendar) and the push channel is forgotten (it watched the old account).
create or replace function public.google_connection_save(
  p_user_id uuid,
  p_account_email text,
  p_refresh_token text,
  p_scopes text[],
  p_primary_calendar_id text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
  v_name text := 'google_refresh_token_' || p_user_id::text;
begin
  -- Two parallel OAuth callbacks for the same user would otherwise both create a secret with the same name.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('calendar_connection:' || p_user_id::text, 0));

  select refresh_token_secret_id into v_secret from public.calendar_connections where user_id = p_user_id;
  if v_secret is null then
    -- A leftover secret with the same name (e.g. after an aborted disconnect) would block the insert.
    delete from vault.secrets where name = v_name;
    v_secret := vault.create_secret(p_refresh_token, v_name, 'Google refresh token of a calendar connection');
  else
    perform vault.update_secret(v_secret, p_refresh_token);
  end if;

  insert into public.calendar_connections (user_id, account_email, refresh_token_secret_id, scopes, primary_calendar_id, status, connected_at)
  values (p_user_id, lower(p_account_email), v_secret, p_scopes, p_primary_calendar_id, 'ok', now())
  on conflict (user_id) do update set
    account_email = excluded.account_email,
    refresh_token_secret_id = excluded.refresh_token_secret_id,
    scopes = excluded.scopes,
    primary_calendar_id = coalesce(excluded.primary_calendar_id, public.calendar_connections.primary_calendar_id),
    busy_calendar_ids = case
      when public.calendar_connections.account_email = excluded.account_email then public.calendar_connections.busy_calendar_ids
      else array[coalesce(excluded.primary_calendar_id, excluded.account_email)]
    end,
    sync_token = case when public.calendar_connections.account_email = excluded.account_email then public.calendar_connections.sync_token end,
    synced_at = case when public.calendar_connections.account_email = excluded.account_email then public.calendar_connections.synced_at end,
    channel_id = case when public.calendar_connections.account_email = excluded.account_email then public.calendar_connections.channel_id end,
    channel_resource_id = case when public.calendar_connections.account_email = excluded.account_email then public.calendar_connections.channel_resource_id end,
    channel_token_hash = case when public.calendar_connections.account_email = excluded.account_email then public.calendar_connections.channel_token_hash end,
    channel_expires_at = case when public.calendar_connections.account_email = excluded.account_email then public.calendar_connections.channel_expires_at end,
    channel_renewed_at = case when public.calendar_connections.account_email = excluded.account_email then public.calendar_connections.channel_renewed_at end,
    status = 'ok',
    connected_at = now();
end;
$$;
