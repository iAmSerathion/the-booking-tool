import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// dispatchOutbox with booking_outbox kept in memory (the pending guard on updates) and fetch against a local server.
// The claim SQL itself is tested against Postgres in tests/db/outbox.test.ts.

type Row = Record<string, unknown> & { id: string; type: string; booking_id: string; payload: unknown; attempts: number; next_attempt_at: string; created_at: string };

const state = vi.hoisted(() => ({
  rows: [] as Row[],
  claims: [] as Record<string, unknown>[],
  // Ids the next claim returns (once).
  claimable: [] as string[],
  webhook: null as { url: string; secret: string } | null,
  // Merged into the rows the claim returns, to hand out a stale lease.
  stale: {} as Record<string, unknown>,
}));

vi.mock("@/lib/config", () => ({ getConfig: () => ({ webhook: state.webhook }) }));
vi.mock("@/lib/db/admin", () => ({
  createAdminSupabase: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe("claim_booking_outbox");
      state.claims.push(args);
      const ids = state.claimable;
      state.claimable = [];
      return { data: args.p_configured ? state.rows.filter((r) => ids.includes(r.id)).map((r) => ({ ...r, ...state.stale })) : [], error: null };
    },
    from: () => ({
      update: (values: Record<string, unknown>) => {
        const filters: [string, unknown][] = [];
        const chain = {
          eq: (column: string, value: unknown) => (filters.push([column, value]), chain),
          is: (column: string, value: unknown) => (filters.push([column, value]), chain),
          select: () => chain,
          then: (resolve: (r: unknown) => unknown) => {
            const matched = state.rows.filter((row) => filters.every(([c, v]) => (row[c] ?? null) === v));
            for (const row of matched) Object.assign(row, values);
            return resolve({ data: matched.map((row) => ({ id: row.id })), error: null });
          },
        };
        return chain;
      },
    }),
  }),
}));

const { dispatchOutbox, nextWebhookAttempt, postWebhook, webhookRetryMinutes, webhookSignature } = await import("./dispatcher");

const secret = "s".repeat(32);
const requests: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
let answer = 200;
let server: ReturnType<typeof createServer>;
let url = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ headers: req.headers, body });
      if (answer === 302) res.setHeader("location", "http://127.0.0.1:1/elsewhere");
      res.statusCode = answer;
      res.end("secret details from the receiver");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const now = new Date("2026-12-01T10:00:00Z");
const row = (id: string, bookingId = "b1"): Row => ({
  id,
  type: "booking.created",
  booking_id: bookingId,
  payload: { id: bookingId, attendee: { name: "Ada", email: "ada@example.com" } },
  attempts: 0,
  next_attempt_at: "2026-12-01T09:59:00+00:00",
  created_at: "2026-12-01T09:58:00+00:00",
  delivered_at: null,
  given_up_at: null,
  last_error: null,
});

beforeEach(() => {
  state.rows = [];
  state.claims = [];
  state.claimable = [];
  state.stale = {};
  state.webhook = { url, secret };
  requests.length = 0;
  answer = 200;
});

describe("nextWebhookAttempt", () => {
  it("backs off and then gives up", () => {
    expect(nextWebhookAttempt(1, now)).toEqual(new Date(now.getTime() + 60_000));
    expect(nextWebhookAttempt(webhookRetryMinutes.length, now)).toEqual(new Date(now.getTime() + 720 * 60_000));
    expect(nextWebhookAttempt(webhookRetryMinutes.length + 1, now)).toBeNull();
  });
});

describe("postWebhook", () => {
  it("signs the exact body and sends the event headers", async () => {
    expect(await postWebhook({ url, secret }, row("o1"))).toBeNull();
    const [{ headers, body }] = requests;
    expect(JSON.parse(body)).toEqual({ id: "o1", type: "booking.created", created_at: "2026-12-01T09:58:00+00:00", booking: row("o1").payload });
    expect(headers).toMatchObject({
      "content-type": "application/json",
      "user-agent": "the-booking-tool",
      "x-webhook-id": "o1",
      "x-webhook-event": "booking.created",
      "x-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    });
    expect(webhookSignature(secret, body)).toBe(headers["x-signature"]);
  });

  it("reports a short status for errors and redirects, never the response body", async () => {
    answer = 500;
    expect(await postWebhook({ url, secret }, row("o1"))).toBe("http 500");
    answer = 302;
    expect(await postWebhook({ url, secret }, row("o1"))).toBe("http 302");
    expect(requests).toHaveLength(2);
    expect(await postWebhook({ url: "http://127.0.0.1:1/closed", secret }, row("o1"))).toBe("network error");
  });

  it("reports a timeout", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    expect(await postWebhook({ url, secret }, row("o1"))).toBe("timeout");
    fetchSpy.mockRestore();
  });
});

describe("dispatchOutbox", () => {
  it("delivers a claimed row once and claims again for the booking's next event", async () => {
    state.rows = [row("o1"), row("o2")];
    state.claimable = ["o1"];
    const result = await dispatchOutbox({ now });
    expect(result).toEqual({ delivered: 1, retry: 0, failed: 0 });
    expect(state.rows[0]).toMatchObject({ attempts: 1, last_error: null });
    expect(state.rows[0].delivered_at).toEqual(expect.any(String));
    // A second claim ran after the delivery (it found nothing more), with the scheduler's arguments.
    expect(state.claims).toHaveLength(2);
    expect(state.claims[0]).toEqual({ p_now: now.toISOString(), p_limit: 50, p_lease_minutes: 2, p_only_booking: null, p_configured: true });
    expect(requests).toHaveLength(1);
  });

  it("schedules a retry from the scheduler's clock, and gives up after the last one", async () => {
    answer = 500;
    state.rows = [row("o1")];
    state.claimable = ["o1"];
    expect(await dispatchOutbox({ now, onlyBooking: "b1" })).toEqual({ delivered: 0, retry: 1, failed: 0 });
    expect(state.rows[0]).toMatchObject({ attempts: 1, last_error: "http 500", next_attempt_at: new Date(now.getTime() + 60_000).toISOString(), delivered_at: null, given_up_at: null });
    expect(state.claims).toHaveLength(1);

    state.rows[0].attempts = webhookRetryMinutes.length;
    state.claimable = ["o1"];
    expect(await dispatchOutbox({ now })).toEqual({ delivered: 0, retry: 0, failed: 1 });
    expect(state.rows[0]).toMatchObject({ attempts: webhookRetryMinutes.length + 1, last_error: "http 500" });
    expect(state.rows[0].given_up_at).toEqual(expect.any(String));
  });

  it("counts the retry from the failed attempt when the run started earlier", async () => {
    answer = 500;
    state.rows = [row("o1")];
    state.claimable = ["o1"];
    // The run began 10 minutes ago (a long batch); a 1-minute retry from that clock would already be due.
    const started = new Date(Date.now() - 10 * 60_000);
    const before = Date.now();
    expect(await dispatchOutbox({ now: started })).toEqual({ delivered: 0, retry: 1, failed: 0 });
    expect(Date.parse(state.rows[0].next_attempt_at)).toBeGreaterThanOrEqual(before + 60_000);
  });

  it("skips a row whose lease another run took meanwhile", async () => {
    state.rows = [row("o1")];
    state.claimable = ["o1"];
    // The claim handed out the lease 10:01, but another run re-claimed the row since.
    state.stale = { next_attempt_at: "2026-12-01T10:01:00+00:00" };
    state.rows[0].next_attempt_at = "2026-12-01T10:03:00+00:00";
    expect(await dispatchOutbox({ now })).toEqual({ delivered: 0, retry: 0, failed: 0 });
    expect(requests).toHaveLength(0);
    expect(state.rows[0]).toMatchObject({ attempts: 0, delivered_at: null });
  });

  it("without a webhook only asks the claim to give due rows up", async () => {
    state.webhook = null;
    state.rows = [row("o1")];
    state.claimable = ["o1"];
    expect(await dispatchOutbox({ now })).toEqual({ delivered: 0, retry: 0, failed: 0 });
    expect(state.claims).toEqual([expect.objectContaining({ p_configured: false })]);
    expect(requests).toHaveLength(0);
  });
});
