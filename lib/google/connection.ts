import { createAdminSupabase } from "@/lib/db/admin";
import { stopChannel } from "./calendar";
import { GoogleError, refreshAccess, revokeToken } from "./oauth";

// A fresh Google access token for a member: refresh token from Vault, then Google. Server code only.
// invalid_grant means the grant is gone (revoked, expired, password change): status needs_reconnect.
// Status writes use the service role; members may only update busy_calendar_ids.

export type Access = { ok: true; token: string } | { ok: false; reason: "not_connected" | "needs_reconnect" | "unavailable" };

export async function googleAccess(userId: string): Promise<Access> {
  const admin = createAdminSupabase();
  const { data: refreshToken, error } = await admin.rpc("google_refresh_token", { p_user_id: userId });
  if (error) return { ok: false, reason: "unavailable" };
  if (!refreshToken) return { ok: false, reason: "not_connected" };

  try {
    const { access_token } = await refreshAccess(refreshToken as string);
    await admin.from("calendar_connections").update({ status: "ok", token_refreshed_at: new Date().toISOString() }).eq("user_id", userId);
    return { ok: true, token: access_token };
  } catch (cause) {
    if (cause instanceof GoogleError && cause.code === "invalid_grant") {
      await admin.from("calendar_connections").update({ status: "needs_reconnect" }).eq("user_id", userId);
      return { ok: false, reason: "needs_reconnect" };
    }
    return { ok: false, reason: "unavailable" };
  }
}

// Stop the push channel (best effort, while access still works; an orphaned channel expires within 7 days), give the
// grant back to Google (best effort), then delete the token and the connection row. False if the database failed.
// Covers the settings disconnect and deactivation. A calendar account switch drops the channel columns in
// google_connection_save instead, which orphans the old channel at Google until it expires.
export async function disconnectGoogle(userId: string): Promise<boolean> {
  const admin = createAdminSupabase();
  const { data: token, error: readError } = await admin.rpc("google_refresh_token", { p_user_id: userId });
  if (readError) return false;
  if (token) {
    await stopCalendarChannel(userId, token as string);
    await revokeToken(token as string);
  }
  const { error } = await admin.rpc("google_connection_delete", { p_user_id: userId });
  return !error;
}

async function stopCalendarChannel(userId: string, refreshToken: string) {
  try {
    const { data } = await createAdminSupabase().from("calendar_connections").select("channel_id, channel_resource_id").eq("user_id", userId).maybeSingle();
    if (!data?.channel_id || !data.channel_resource_id) return;
    const { access_token } = await refreshAccess(refreshToken);
    await stopChannel(access_token, { id: data.channel_id, resourceId: data.channel_resource_id });
  } catch (cause) {
    console.error("calendar channel: stop", userId, cause);
  }
}
