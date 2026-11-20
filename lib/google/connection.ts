import { createAdminSupabase } from "@/lib/db/admin";
import { GoogleError, refreshAccess } from "./oauth";

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
