import { parseReminderOffsets, reminderJobs } from "@/lib/core/jobs";
import { createAdminSupabase } from "@/lib/db/admin";

// The configured reminder offsets (settings key reminder_offsets_minutes), or the defaults.
export async function loadReminderOffsets(): Promise<number[]> {
  const { data, error } = await createAdminSupabase().from("settings").select("value").eq("key", "reminder_offsets_minutes").maybeSingle();
  if (error) throw error;
  return parseReminderOffsets(data?.value ?? null);
}

// Plans the booking's reminders for its current start; plan_booking_jobs cancels the open ones first. Call it only after
// the booking or its new time has committed. Never throws: a failed plan means missing reminders, never stale ones (the
// cancel trigger already killed those), so it is only logged. Server code only.
export async function planBookingJobs(bookingId: string, now = new Date()): Promise<void> {
  try {
    const db = createAdminSupabase();
    const [{ data: booking, error }, offsets] = await Promise.all([db.from("bookings").select("starts_at").eq("id", bookingId).single(), loadReminderOffsets()]);
    if (error) throw error;
    const jobs = reminderJobs({ startsAt: new Date(booking.starts_at), now, offsets });
    const { error: planError } = await db.rpc("plan_booking_jobs", {
      p_booking_id: bookingId,
      p_jobs: jobs.map((j) => ({ step_key: j.stepKey, run_at: j.runAt.toISOString() })),
      // A booking moved since the read plans nothing; whoever moved it plans for the new start.
      p_starts_at: booking.starts_at,
    });
    if (planError) throw planError;
  } catch (cause) {
    console.error("jobs: plan", bookingId, cause);
  }
}
