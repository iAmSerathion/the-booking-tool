-- A sync that runs while the host switches calendar accounts must not store the old calendar's sync token on the new
-- connection. calendar_sync_claim now returns its claim (sync_claimed_at), calendar_sync_release saves only for that very
-- claim, and an account switch voids a running claim and asks for a sync.

-- Same as 20261201000800, plus: when the account email changes, the running sync's claim is voided (its token belongs to
-- the old calendar) and sync_again is set.
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
    sync_claimed_at = case when public.calendar_connections.account_email = excluded.account_email then public.calendar_connections.sync_claimed_at end,
    sync_again = public.calendar_connections.account_email <> excluded.account_email or public.calendar_connections.sync_again,
    channel_id = case when public.calendar_connections.account_email = excluded.account_email then public.calendar_connections.channel_id end,
    channel_resource_id = case when public.calendar_connections.account_email = excluded.account_email then public.calendar_connections.channel_resource_id end,
    channel_token_hash = case when public.calendar_connections.account_email = excluded.account_email then public.calendar_connections.channel_token_hash end,
    channel_expires_at = case when public.calendar_connections.account_email = excluded.account_email then public.calendar_connections.channel_expires_at end,
    channel_renewed_at = case when public.calendar_connections.account_email = excluded.account_email then public.calendar_connections.channel_renewed_at end,
    status = 'ok',
    connected_at = now();
end;
$$;

-- Same as before, plus claimed_at: the claim's id, to hand back to calendar_sync_release. clock_timestamp(), so two
-- claims never share an id, not even within one transaction.
create or replace function public.calendar_sync_claim(p_user_id uuid) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_row public.calendar_connections%rowtype;
begin
  update public.calendar_connections
  set sync_claimed_at = pg_catalog.clock_timestamp(), sync_again = false
  where user_id = p_user_id
    and (sync_claimed_at is null or sync_claimed_at < now() - interval '2 minutes')
  returning * into v_row;
  if not found then
    update public.calendar_connections set sync_again = true where user_id = p_user_id;
    return null;
  end if;
  return jsonb_build_object('sync_token', v_row.sync_token, 'primary_calendar_id', v_row.primary_calendar_id, 'claimed_at', v_row.sync_claimed_at);
end;
$$;

-- Release a sync: new sync token (p_save_token false keeps the old one because an event had to wait), sync time.
-- Only while p_claimed_at is still the row's claim: after an account switch (or a takeover of a stale claim) nothing is
-- written, and true is returned so the caller syncs again with the current connection. Otherwise returns whether a new
-- notification arrived in the meantime.
drop function public.calendar_sync_release(uuid, text, boolean);

create function public.calendar_sync_release(p_user_id uuid, p_sync_token text, p_save_token boolean, p_claimed_at timestamptz) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_again boolean;
  v_claimed_at timestamptz;
begin
  select sync_again, sync_claimed_at into v_again, v_claimed_at from public.calendar_connections where user_id = p_user_id for update;
  if not found then
    return false;
  end if;
  if v_claimed_at is distinct from p_claimed_at then
    return true;
  end if;
  update public.calendar_connections
  set sync_token = case when p_save_token then p_sync_token else sync_token end,
      synced_at = now(),
      sync_claimed_at = null,
      sync_again = false
  where user_id = p_user_id;
  return coalesce(v_again, false);
end;
$$;

revoke execute on function public.calendar_sync_release(uuid, text, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.calendar_sync_release(uuid, text, boolean, timestamptz) to service_role;
