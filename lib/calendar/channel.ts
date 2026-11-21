import { randomUUID, timingSafeEqual } from "node:crypto";
import { hashToken, newToken } from "@/lib/booking/token";
import { getConfig } from "@/lib/config";
import { channelTtlSeconds, webhookAddress } from "@/lib/core/calendar-sync";
import { createAdminSupabase } from "@/lib/db/admin";
import { stopChannel, watchEvents } from "@/lib/google/calendar";
import { googleAccess } from "@/lib/google/connection";
import { calendarScope } from "@/lib/google/scopes";

// A push channel per member on the primary calendar: Google notifies /api/google/calendar-webhook of every change, with
// the channel id and a secret stored only as a hash. The scheduler renews it daily: the new channel first, then the old
// one is stopped, so no notification is lost. Disconnecting stops it (lib/google/connection.ts). Server code only.
//
// Two parallel renewals can orphan a channel: its notifications then fail the lookup below, and it expires within 7 days.

export type ChannelOutcome = "renewed" | "no_address" | "not_connected" | "failed";

export async function renewCalendarChannel(userId: string): Promise<ChannelOutcome> {
  const db = createAdminSupabase();
  const { data: connection, error } = await db
    .from("calendar_connections")
    .select("scopes, primary_calendar_id, channel_id, channel_resource_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!connection?.primary_calendar_id || !connection.scopes.includes(calendarScope)) return "not_connected";
  const config = getConfig();
  // From APP_URL only, never from a request.
  const address = webhookAddress(config.appUrl, !!config.google.fakeUrl);
  if (!address) return "no_address";
  const access = await googleAccess(userId);
  if (!access.ok) return access.reason === "unavailable" ? "failed" : "not_connected";

  const id = randomUUID();
  const token = newToken();
  try {
    const { resourceId, expiresAt } = await watchEvents(access.token, connection.primary_calendar_id, { id, token, address, ttlSeconds: channelTtlSeconds });
    const { error: saveError } = await db
      .from("calendar_connections")
      .update({
        channel_id: id,
        channel_resource_id: resourceId,
        channel_token_hash: hashToken(token),
        channel_expires_at: expiresAt.toISOString(),
        channel_renewed_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
    if (saveError) throw saveError;
  } catch (cause) {
    // Google refused the channel (address not allowed, say): try again in an hour; the safety sync keeps the calendar
    // current meanwhile, and an old channel runs on until it expires.
    console.error("calendar channel: watch", userId, cause);
    await db.from("calendar_connections").update({ channel_renewed_at: new Date().toISOString() }).eq("user_id", userId);
    return "failed";
  }

  if (connection.channel_id && connection.channel_resource_id) {
    await stopChannel(access.token, { id: connection.channel_id, resourceId: connection.channel_resource_id }).catch((cause) =>
      console.error("calendar channel: stop old", userId, cause),
    );
  }
  return "renewed";
}

// The member a notification belongs to: channel id and secret must match. Null otherwise.
export async function channelUser(channelId: string, token: string): Promise<string | null> {
  const { data } = await createAdminSupabase().from("calendar_connections").select("user_id, channel_token_hash").eq("channel_id", channelId).maybeSingle();
  if (!data?.channel_token_hash) return null;
  const a = Buffer.from(hashToken(token));
  const b = Buffer.from(data.channel_token_hash);
  return a.length === b.length && timingSafeEqual(a, b) ? data.user_id : null;
}
