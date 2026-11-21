import { createHmac } from "node:crypto";
import { getConfig } from "@/lib/config";
import { createAdminSupabase } from "@/lib/db/admin";

// Outbound webhooks: the booking RPCs write a booking_outbox row in the same transaction as the change; this scheduler
// step POSTs each row to WEBHOOK_URL, signed with WEBHOOK_SECRET (README "Webhooks"). Delivery is at least once: if the
// receiver answers 2xx and the "delivered" update is lost, the row is sent again with the same id, so receivers dedupe by
// X-Webhook-Id. claim_booking_outbox only hands out a booking's oldest pending row, so a booking's events arrive in order.

// Minutes to wait after the 1st, 2nd, ... failed attempt; after the last one the row is given up.
export const webhookRetryMinutes = [1, 5, 30, 120, 360, 720];
// While an attempt runs, the row is leased this long, so another scheduler run does not send it at the same time.
export const webhookLeaseMinutes = 2;
export const webhookTimeoutMs = 10_000;

export type OutboxRow = { id: string; type: string; booking_id: string; payload: unknown; attempts: number; next_attempt_at: string; created_at: string };
type Webhook = { url: string; secret: string };

// When to try again after `attempts` failed attempts, from the scheduler's clock, or null to give up.
export function nextWebhookAttempt(attempts: number, now: Date): Date | null {
  const delay = webhookRetryMinutes[attempts - 1];
  return delay === undefined ? null : new Date(now.getTime() + delay * 60_000);
}

export const webhookBody = (row: OutboxRow) => JSON.stringify({ id: row.id, type: row.type, created_at: row.created_at, booking: row.payload });
export const webhookSignature = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

// One POST; returns null when delivered (any 2xx), else a short reason for last_error. The response body is never read or
// stored. A redirect is a failure: following it could send the signed payload somewhere else.
export async function postWebhook(webhook: Webhook, row: OutboxRow): Promise<string | null> {
  const body = webhookBody(row);
  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "user-agent": "the-booking-tool",
        "x-signature": webhookSignature(webhook.secret, body),
        "x-webhook-id": row.id,
        "x-webhook-event": row.type,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(webhookTimeoutMs),
    });
    await response.body?.cancel().catch(() => {});
    return response.status >= 200 && response.status < 300 ? null : `http ${response.status}`;
  } catch (cause) {
    return cause instanceof Error && cause.name === "TimeoutError" ? "timeout" : "network error";
  }
}

// Scheduler step. now: the scheduler's clock (simulated in tests) decides what is due and when a retry is; onlyBooking
// scopes a test run to one booking. Without WEBHOOK_URL the claim gives due rows up instead of returning them.
// budgetMs: wall-clock time (the real clock, not now) after which no new round is claimed and no new POST starts, so
// minute runs do not pile up; a POST already started may finish (webhookTimeoutMs), keeping this step near 50 s at worst
// (the scheduler steps before it have no budget of their own).
// Rows claimed but not tried keep their short lease and a later run picks them up, without using an attempt.
export async function dispatchOutbox({ now = new Date(), onlyBooking = null, budgetMs = 40_000 }: { now?: Date; onlyBooking?: string | null; budgetMs?: number } = {}) {
  const deadline = Date.now() + budgetMs;
  const webhook = getConfig().webhook;
  const db = createAdminSupabase();
  const counts = { delivered: 0, retry: 0, failed: 0 };
  // A claim returns at most one row per booking; claiming again lets a booking's next event follow in the same run.
  for (let round = 0; round < 10 && Date.now() < deadline; round++) {
    const { data, error } = await db.rpc("claim_booking_outbox", {
      p_now: now.toISOString(),
      p_limit: 50,
      p_lease_minutes: webhookLeaseMinutes,
      p_only_booking: onlyBooking,
      p_configured: webhook !== null,
    });
    if (error) throw error;
    const rows = data as OutboxRow[];
    if (!webhook || !rows.length) break;
    let delivered = 0;
    for (const row of rows) {
      if (Date.now() >= deadline) break;
      const result = await deliverOne(webhook, row, now);
      if (result !== "skipped") counts[result]++;
      if (result === "delivered") delivered++;
    }
    if (!delivered) break;
  }
  return counts;
}

// Takes the lease again right before the attempt, only if this run's claim still holds it (no other run took the row
// after that lease ran out while this batch was busy); skipped otherwise. Every update only applies while the row is
// pending, so two runs racing on one row cannot undo each other's result.
async function deliverOne(webhook: Webhook, row: OutboxRow, now: Date): Promise<"delivered" | "retry" | "failed" | "skipped"> {
  const db = createAdminSupabase();
  const lease = new Date(Math.max(Date.now(), now.getTime()) + webhookLeaseMinutes * 60_000);
  const { data, error } = await db
    .from("booking_outbox")
    .update({ next_attempt_at: lease.toISOString() })
    .eq("id", row.id)
    .is("delivered_at", null)
    .is("given_up_at", null)
    .eq("next_attempt_at", row.next_attempt_at)
    .select("id");
  if (error) {
    console.error("webhook: lease", row.id, error);
    return "skipped";
  }
  if (!data.length) return "skipped";

  const attempts = row.attempts + 1;
  const failure = await postWebhook(webhook, row);
  // From the end of this attempt, not the run's start: a long batch would otherwise schedule retries already due.
  const next = failure ? nextWebhookAttempt(attempts, new Date(Math.max(Date.now(), now.getTime()))) : null;
  const values = !failure
    ? { delivered_at: new Date().toISOString(), attempts, last_error: null }
    : next
      ? { attempts, last_error: failure, next_attempt_at: next.toISOString() }
      : { attempts, last_error: failure, given_up_at: new Date().toISOString() };
  if (failure) console.error("webhook: deliver", row.id, failure);
  const { error: recordError } = await db.from("booking_outbox").update(values).eq("id", row.id).is("delivered_at", null).is("given_up_at", null);
  if (recordError) console.error("webhook: record", row.id, recordError);
  return !failure ? "delivered" : next ? "retry" : "failed";
}
