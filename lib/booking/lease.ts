import { createAdminSupabase } from "@/lib/db/admin";

// While google_change_until lies in the future, the calendar sync (M8) ignores Google changes to the booking, and a
// second change of the same booking waits. hold_slot does not lock the booking itself: without this, two reschedules of
// one booking could move the Google event in one order and commit in the other. A plain module, not "use server".
const leaseSeconds = 120;

// The lease's end (ISO) when taken, null when another change holds it. Pass it back to dropLease.
export async function takeLease(bookingId: string): Promise<string | null> {
  const now = new Date();
  const until = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  const { data, error } = await createAdminSupabase()
    .from("bookings")
    .update({ google_change_until: until })
    .eq("id", bookingId)
    .or(`google_change_until.is.null,google_change_until.lt.${now.toISOString()}`)
    .select("id");
  return !error && data.length === 1 ? until : null;
}

// Clears only our own lease: after it expired, another change may hold the booking with a lease of its own.
export async function dropLease(bookingId: string, until: string) {
  const { error } = await createAdminSupabase().from("bookings").update({ google_change_until: null }).eq("id", bookingId).eq("google_change_until", until);
  if (error) console.error("booking: lease release", error);
}
