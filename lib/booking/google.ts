import { createAdminSupabase } from "@/lib/db/admin";
import { deleteEvent, listBookingEvents } from "@/lib/google/calendar";
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

// Deletes every booking event in the host's current primary calendar that starts at or after `from`; Google tells the
// guests. For a deactivated member, who hosts no booking from then on: it also catches an event that an invitee's booking
// created while the hand-over committed (that booking then failed, and its own cleanup may come after the revoke).
// Never throws; false when some may still be there (logged).
export async function removeBookingEventsFrom(hostId: string, from: Date): Promise<boolean> {
  try {
    const [access, connection] = await Promise.all([
      googleAccess(hostId),
      createAdminSupabase().from("calendar_connections").select("primary_calendar_id").eq("user_id", hostId).maybeSingle(),
    ]);
    // No connection, nothing to sweep.
    if (!access.ok && access.reason === "not_connected") return true;
    if (!access.ok || connection.error || !connection.data?.primary_calendar_id) {
      console.error("booking: event sweep skipped", access.ok ? (connection.error ?? "no primary calendar") : access.reason);
      return false;
    }
    const calendar = connection.data.primary_calendar_id;
    for (const id of await listBookingEvents(access.token, calendar, from)) await deleteEvent(access.token, calendar, id, "all");
    return true;
  } catch (cause) {
    console.error("booking: event sweep", cause);
    return false;
  }
}
