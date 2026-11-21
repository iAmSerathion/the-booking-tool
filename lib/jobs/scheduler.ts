import { checkJob, claimMinutes, jobAttempts } from "@/lib/core/jobs";
import { createAdminSupabase } from "@/lib/db/admin";
import { sendReminderMail } from "@/lib/mail/booking";
import { loadReminderOffsets } from "./plan";

type Job = { id: string; booking_id: string; step_key: string; planned_for: string; attempts: number };

// Scheduler step: claims due jobs, checks each against its booking and runs it, each on its own. now: the scheduler's
// clock (simulated in tests); onlyBooking scopes a test run to one booking. Server code only.
export async function runJobs({ now = new Date(), onlyBooking = null }: { now?: Date; onlyBooking?: string | null } = {}) {
  const db = createAdminSupabase();
  const { data, error } = await db.rpc("claim_due_jobs", { p_now: now.toISOString(), p_limit: 50, p_claim_minutes: claimMinutes, p_only_booking: onlyBooking });
  if (error) throw error;
  const jobs = data as Job[];
  const counts = { done: 0, cancelled: 0, retry: 0, failed: 0 };
  if (!jobs.length) return counts;

  const [{ data: rows, error: readError }, offsets] = await Promise.all([
    db.from("bookings").select("id, state, starts_at").in("id", [...new Set(jobs.map((j) => j.booking_id))]),
    loadReminderOffsets(),
  ]);
  if (readError) throw readError;
  const bookings = new Map(rows.map((b) => [b.id, { state: b.state as string, startsAt: new Date(b.starts_at) }]));

  const finish = async (job: Job, state: "done" | "cancelled" | "failed" | "planned", reason: string | null) => {
    const { error: finishError } = await db.rpc("finish_job", { p_job_id: job.id, p_state: state, p_error: reason?.slice(0, 500) ?? null });
    if (finishError) console.error("jobs: finish", job.id, finishError);
    counts[state === "planned" ? "retry" : state]++;
  };

  for (const job of jobs) {
    try {
      const plannedFor = new Date(job.planned_for);
      const check = checkJob({ stepKey: job.step_key, plannedFor, booking: bookings.get(job.booking_id) ?? null, offsets, now });
      if (!check.run) {
        await finish(job, check.state, check.reason);
        continue;
      }
      // A mail that cannot be delivered is sendMail's retry, not a job failure.
      await sendReminderMail(job.booking_id, { stepKey: job.step_key, plannedFor, sendUntil: check.sendUntil });
      await finish(job, "done", null);
    } catch (cause) {
      console.error("jobs: run", job.id, cause);
      // claim_due_jobs already counted this attempt.
      await finish(job, job.attempts >= jobAttempts ? "failed" : "planned", cause instanceof Error ? cause.message : String(cause));
    }
  }
  return counts;
}
