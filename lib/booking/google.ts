import { createAdminSupabase } from "@/lib/db/admin";
import { deleteEvent } from "@/lib/google/calendar";
import { googleAccess } from "@/lib/google/connection";

// Removes a booking's event from its host's Google calendar after the booking was cancelled; Google tells the guest.
// Uses the host's CURRENT primary calendar: after a switch of calendar account the old event is not found there, and
// 404/410 count as done. Never throws; false when the event may still be there (logged). Server code only.
export async function removeBookingEvent(hostId: string, googleEventId: string | null): Promise<boolean> {
  if (!googleEventId) return true;
  try {
    const [access, connection] = await Promise.all([
      googleAccess(hostId),
      createAdminSupabase().from("calendar_connections").select("primary_calendar_id").eq("user_id", hostId).maybeSingle(),
    ]);
    if (!access.ok || connection.error || !connection.data?.primary_calendar_id) {
      console.error("booking: event delete skipped", access.ok ? (connection.error ?? "no primary calendar") : access.reason);
      return false;
    }
    await deleteEvent(access.token, connection.data.primary_calendar_id, googleEventId, "all");
    return true;
  } catch (cause) {
    console.error("booking: event delete", cause);
    return false;
  }
}
