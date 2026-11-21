import { channelDue, syncDue } from "@/lib/core/calendar-sync";
import { createAdminSupabase } from "@/lib/db/admin";
import { calendarScope } from "@/lib/google/scopes";
import { renewCalendarChannel } from "./channel";
import { syncCalendar } from "./sync";

// Calendar upkeep in the scheduler, every minute: for each connected calendar, a new push channel when the old one is a
// day old or expires soon, and a sync when the last one is 15 minutes old (in case a notification got lost). One
// member's failure does not stop the others.

export type CalendarUpkeep = { renewed: number; synced: number; failed: number };

// onlyUser: just this member (the scheduler's test clock).
export async function calendarUpkeep({ now, onlyUser = null }: { now: Date; onlyUser?: string | null }): Promise<CalendarUpkeep> {
  let query = createAdminSupabase()
    .from("calendar_connections")
    .select("user_id, channel_id, channel_renewed_at, channel_expires_at, synced_at")
    .eq("status", "ok")
    .not("primary_calendar_id", "is", null)
    .contains("scopes", [calendarScope]);
  if (onlyUser) query = query.eq("user_id", onlyUser);
  const { data, error } = await query;
  if (error) throw error;

  const result: CalendarUpkeep = { renewed: 0, synced: 0, failed: 0 };
  const date = (value: string | null) => (value ? new Date(value) : null);
  for (const c of data) {
    try {
      if (channelDue({ channelId: c.channel_id, renewedAt: date(c.channel_renewed_at), expiresAt: date(c.channel_expires_at), now })) {
        const outcome = await renewCalendarChannel(c.user_id);
        if (outcome === "renewed") result.renewed++;
        else if (outcome === "failed") result.failed++;
      }
      if (syncDue(date(c.synced_at), now)) {
        const outcome = await syncCalendar(c.user_id, { now: () => now });
        if (outcome === "synced") result.synced++;
        else if (outcome === "failed") result.failed++;
      }
    } catch (cause) {
      console.error("calendar upkeep", c.user_id, cause);
      result.failed++;
    }
  }
  return result;
}
