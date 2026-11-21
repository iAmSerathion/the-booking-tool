import { getConfig } from "@/lib/config";
import { createAdminSupabase } from "@/lib/db/admin";
import { oneLine } from "./compose";
import { mailTransport } from "./transport";

// Sending a mail: one outbound_mails row per occasion, written BEFORE the first attempt. send_key makes each occasion
// send at most once: a second insert with the same key fails (23505) and nothing is sent. The row stores the composed
// mail, so the scheduler's retries (retryDueMails) send exactly that, with backoff, and never at or after send_until.
// shortcut: delivery is at least once per send_key, not exactly once: if SMTP accepts the mail and the "sent" update is
// lost, a retry sends it again. Fixing that needs the SMTP server's help (message ids), not worth it for these mails.

export type OutgoingMail = {
  // "<kind>:<booking id>[:<discriminator>]"; the kind is the first segment.
  sendKey: string;
  bookingId: string | null;
  to: string;
  replyTo: string | null;
  subject: string;
  text: string;
  html: string;
  // After this the mail is no longer sent or retried; null: until the attempts run out.
  sendUntil: Date | null;
};

export type SendResult = "sent" | "duplicate" | "expired" | "retry" | "failed";

// Minutes to wait after the 1st, 2nd, ... failed attempt; after the last one the mail is failed.
export const retryDelayMinutes = [1, 5, 30, 120, 360];
// While an attempt runs, the row is leased this long, so a scheduler run does not grab it at the same time. A retry
// takes the lease again right before its attempt (retryOne), so a slow batch cannot outlive the claim's lease.
export const attemptLeaseMinutes = 2;

// When to try again after `attempts` failed attempts, or null to give up (attempts used up, or past send_until).
export function nextAttempt(attempts: number, now: Date, sendUntil: Date | null): Date | null {
  const delay = retryDelayMinutes[attempts - 1];
  if (delay === undefined) return null;
  const next = new Date(now.getTime() + delay * 60_000);
  return sendUntil && next >= sendUntil ? null : next;
}

type Row = { id: string; to: string[]; reply_to: string | null; subject: string; body_text: string; body_html: string | null; attempts: number; send_until: string | null };
type ClaimedRow = Row & { next_attempt_at: string };

export async function sendMail(mail: OutgoingMail): Promise<SendResult> {
  const now = new Date();
  if (mail.sendUntil && now >= mail.sendUntil) return "expired";
  const { data, error } = await createAdminSupabase()
    .from("outbound_mails")
    .insert({
      send_key: mail.sendKey,
      booking_id: mail.bookingId,
      kind: mail.sendKey.split(":")[0],
      to: [mail.to],
      reply_to: mail.replyTo,
      subject: oneLine(mail.subject),
      body_text: mail.text,
      body_html: mail.html,
      send_until: mail.sendUntil?.toISOString() ?? null,
      next_attempt_at: new Date(now.getTime() + attemptLeaseMinutes * 60_000).toISOString(),
    })
    .select("id, to, reply_to, subject, body_text, body_html, attempts, send_until")
    .single();
  if (error?.code === "23505") return "duplicate";
  if (error) throw error;
  return attempt(data as Row);
}

// One delivery attempt of a stored row. Every update only applies while the row is pending, so an inline attempt and a
// scheduler retry that race on one row cannot undo each other's result.
async function attempt(row: Row): Promise<"sent" | "retry" | "failed"> {
  const db = createAdminSupabase();
  const attempts = row.attempts + 1;
  try {
    await mailTransport().sendMail({
      from: getConfig().mail.from,
      to: row.to,
      replyTo: row.reply_to ?? undefined,
      subject: row.subject,
      text: row.body_text,
      html: row.body_html ?? undefined,
    });
  } catch (cause) {
    // The real clock, also under a test clock: send_until is a promise to the recipient.
    const next = nextAttempt(attempts, new Date(), row.send_until ? new Date(row.send_until) : null);
    const lastError = (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);
    console.error("mail: send", row.id, lastError);
    const { error } = await db
      .from("outbound_mails")
      .update(next ? { attempts, last_error: lastError, next_attempt_at: next.toISOString() } : { attempts, last_error: lastError, state: "failed" })
      .eq("id", row.id)
      .eq("state", "pending");
    if (error) console.error("mail: record failure", row.id, error);
    return next ? "retry" : "failed";
  }
  const { error } = await db.from("outbound_mails").update({ state: "sent", sent_at: new Date().toISOString(), attempts, last_error: null }).eq("id", row.id).eq("state", "pending");
  if (error) console.error("mail: record sent", row.id, error);
  return "sent";
}

// Scheduler step: retries pending mails whose next attempt is due (claim_mail_retries also fails expired ones).
// now: the scheduler's clock (simulated in tests) decides which attempts are due; onlyBooking scopes a test run.
export async function retryDueMails({ now = new Date(), onlyBooking = null }: { now?: Date; onlyBooking?: string | null } = {}) {
  const { data, error } = await createAdminSupabase().rpc("claim_mail_retries", {
    p_now: now.toISOString(),
    p_limit: 50,
    p_lease_minutes: attemptLeaseMinutes,
    p_only_booking: onlyBooking,
  });
  if (error) throw error;
  const counts = { sent: 0, retry: 0, failed: 0 };
  for (const row of data as ClaimedRow[]) {
    const result = await retryOne(row);
    if (result !== "skipped") counts[result]++;
  }
  return counts;
}

// A claimed row is sent only if it is still pending, still carries the lease this run's claim gave it (no other run took
// it after that lease ran out while this batch was busy) and is not past send_until; the conditional update renews the
// lease for this attempt. Skipped otherwise: whoever holds it now sends it, claim_mail_retries fails an expired one.
async function retryOne(row: ClaimedRow): Promise<"sent" | "retry" | "failed" | "skipped"> {
  const now = new Date();
  if (row.send_until && new Date(row.send_until) <= now) return "skipped";
  const { data, error } = await createAdminSupabase()
    .from("outbound_mails")
    .update({ next_attempt_at: new Date(now.getTime() + attemptLeaseMinutes * 60_000).toISOString() })
    .eq("id", row.id)
    .eq("state", "pending")
    .eq("next_attempt_at", row.next_attempt_at)
    .select("id");
  if (error) {
    console.error("mail: lease", row.id, error);
    return "skipped";
  }
  return data.length ? attempt(row) : "skipped";
}
