import { createAdminSupabase } from "@/lib/db/admin";

// While google_change_until lies in the future, the calendar sync (M8) ignores Google changes to the booking, and a
// second change of the same booking waits. hold_slot does not lock the booking itself: without this, two reschedules of
// one booking could move the Google event in one order and commit in the other. A plain module, not "use server".
const leaseSeconds = 120;

export async function takeLease(bookingId: string): Promise<boolean> {
  const now = new Date();
  const { data, error } = await createAdminSupabase()
    .from("bookings")
    .update({ google_change_until: new Date(now.getTime() + leaseSeconds * 1000).toISOString() })
    .eq("id", bookingId)
    .or(`google_change_until.is.null,google_change_until.lt.${now.toISOString()}`)
    .select("id");
  return !error && data.length === 1;
}

export async function dropLease(bookingId: string) {
  const { error } = await createAdminSupabase().from("bookings").update({ google_change_until: null }).eq("id", bookingId);
  if (error) console.error("booking: lease release", error);
}
