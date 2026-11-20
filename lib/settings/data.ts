import { createSupabase } from "@/lib/db/server";
import { type CalendarEntry, listCalendars } from "@/lib/google/calendar";
import { googleAccess } from "@/lib/google/connection";

export type CalendarConnection = {
  accountEmail: string;
  needsReconnect: boolean;
  primaryCalendarId: string | null;
  busyCalendarIds: string[];
  // null: Google is unreachable right now; the saved choice stays as it is.
  calendars: CalendarEntry[] | null;
};

// The member's calendar connection, checked against Google on every load so a dead grant shows up at once.
export async function loadCalendarConnection(userId: string): Promise<CalendarConnection | null> {
  const supabase = await createSupabase();
  // Only granted columns: the token's Vault id and sync state are not readable for members.
  const { data: row, error } = await supabase
    .from("calendar_connections")
    .select("account_email, status, primary_calendar_id, busy_calendar_ids")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return null;

  const access = await googleAccess(userId);
  const calendars = access.ok ? await listCalendars(access.token).catch(() => null) : null;
  return {
    accountEmail: row.account_email,
    needsReconnect: access.ok ? false : access.reason === "needs_reconnect" || row.status === "needs_reconnect",
    primaryCalendarId: row.primary_calendar_id,
    busyCalendarIds: row.busy_calendar_ids ?? [],
    calendars,
  };
}
