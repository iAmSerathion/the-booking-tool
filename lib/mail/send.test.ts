import { beforeEach, describe, expect, it, vi } from "vitest";

// sendMail and retryDueMails with outbound_mails kept in memory (unique send_key, the state guard on updates) and a
// stubbed SMTP transport. The claim SQL itself is tested against Postgres in tests/db/mail.test.ts.

type Row = Record<string, unknown> & { id: string; send_key: string; state: string; attempts: number };

const state = vi.hoisted(() => ({
  rows: [] as Row[],
  sent: [] as Record<string, unknown>[],
  failSends: 0,
  claimed: null as string[] | null,
}));

vi.mock("@/lib/config", () => ({ getConfig: () => ({ mail: { from: "Bookings <bookings@example.com>" } }) }));
vi.mock("./transport", () => ({
  mailTransport: () => ({
    sendMail: async (message: Record<string, unknown>) => {
      if (state.failSends > 0) {
        state.failSends--;
        throw new Error("421 try again later");
      }
      state.sent.push(message);
    },
  }),
}));
vi.mock("@/lib/db/admin", () => ({
  createAdminSupabase: () => ({
    rpc: async (name: string, args: { p_only_booking: string | null }) => {
      expect(name).toBe("claim_mail_retries");
      const rows = state.rows.filter((r) => r.state === "pending" && (state.claimed ?? []).includes(r.id) && (!args.p_only_booking || r.booking_id === args.p_only_booking));
      return { data: rows.map((r) => ({ ...r })), error: null };
    },
    from: () => ({
      insert: (values: Record<string, unknown>) => ({
        select: () => ({
          single: async () => {
            if (state.rows.some((r) => r.send_key === values.send_key)) return { data: null, error: { code: "23505" } };
            const row = { id: `row-${state.rows.length + 1}`, state: "pending", attempts: 0, ...values } as Row;
            state.rows.push(row);
            return { data: { ...row }, error: null };
          },
        }),
      }),
      update: (values: Record<string, unknown>) => {
        const filters: [string, unknown][] = [];
        const chain = {
          eq: (column: string, value: unknown) => (filters.push([column, value]), chain),
          select: () => chain,
          then: (resolve: (r: unknown) => unknown) => {
            const matched = state.rows.filter((row) => filters.every(([c, v]) => row[c] === v));
            for (const row of matched) Object.assign(row, values);
            return resolve({ data: matched.map((row) => ({ id: row.id })), error: null });
          },
        };
        return chain;
      },
    }),
  }),
}));

const { nextAttempt, retryDelayMinutes, retryDueMails, sendMail } = await import("./send");

const mail = (key = "confirmation:b1", sendUntil: Date | null = new Date(Date.now() + 86_400_000)) => ({
  sendKey: key,
  bookingId: "b1",
  to: "ada@example.com",
  replyTo: "host@example.com",
  subject: "Confirmed:\r\nBcc: x@example.com",
  text: "Hello",
  html: "<p>Hello</p>",
  sendUntil,
});

beforeEach(() => {
  state.rows = [];
  state.sent = [];
  state.failSends = 0;
  state.claimed = null;
});

describe("nextAttempt", () => {
  const now = new Date("2030-01-01T10:00:00Z");
  it("backs off per failed attempt and gives up after the last delay", () => {
    expect(retryDelayMinutes.map((_, i) => nextAttempt(i + 1, now, null)?.toISOString())).toEqual([
      "2030-01-01T10:01:00.000Z",
      "2030-01-01T10:05:00.000Z",
      "2030-01-01T10:30:00.000Z",
      "2030-01-01T12:00:00.000Z",
      "2030-01-01T16:00:00.000Z",
    ]);
    expect(nextAttempt(retryDelayMinutes.length + 1, now, null)).toBeNull();
  });

  it("gives up when the next attempt would land at or after send_until", () => {
    expect(nextAttempt(2, now, new Date("2030-01-01T10:05:00Z"))).toBeNull();
    expect(nextAttempt(2, now, new Date("2030-01-01T10:05:01Z"))?.toISOString()).toBe("2030-01-01T10:05:00.000Z");
  });
});

describe("sendMail", () => {
  it("sends once per send_key: a second call with the same key sends nothing", async () => {
    expect(await sendMail(mail())).toBe("sent");
    expect(await sendMail(mail())).toBe("duplicate");
    expect(state.sent).toEqual([
      { from: "Bookings <bookings@example.com>", to: ["ada@example.com"], replyTo: "host@example.com", subject: "Confirmed: Bcc: x@example.com", text: "Hello", html: "<p>Hello</p>" },
    ]);
    expect(state.rows).toMatchObject([{ send_key: "confirmation:b1", kind: "confirmation", state: "sent", attempts: 1, last_error: null }]);
    expect(await sendMail(mail("confirmation:b2"))).toBe("sent");
    expect(state.sent).toHaveLength(2);
  });

  it("never sends at or after send_until, and stores nothing then", async () => {
    expect(await sendMail(mail("reminder:b1", new Date(Date.now() - 1)))).toBe("expired");
    expect(state.rows).toEqual([]);
    expect(state.sent).toEqual([]);
  });

  it("keeps a failed mail pending with its next attempt, then fails it when the attempts run out", async () => {
    state.failSends = 99;
    const before = Date.now();
    expect(await sendMail(mail("confirmation:b1", null))).toBe("retry");
    const row = state.rows[0];
    expect(row).toMatchObject({ state: "pending", attempts: 1, last_error: "421 try again later" });
    expect(Date.parse(row.next_attempt_at as string)).toBeGreaterThanOrEqual(before + 60_000);

    state.claimed = [row.id];
    for (let i = 2; i <= retryDelayMinutes.length; i++) expect(await retryDueMails({ onlyBooking: "b1" })).toEqual({ sent: 0, retry: 1, failed: 0 });
    expect(await retryDueMails({ onlyBooking: "b1" })).toEqual({ sent: 0, retry: 0, failed: 1 });
    expect(row).toMatchObject({ state: "failed", attempts: retryDelayMinutes.length + 1 });
    expect(state.sent).toEqual([]);
  });

  it("retries the stored mail, and a retry after success changes nothing", async () => {
    state.failSends = 1;
    expect(await sendMail(mail())).toBe("retry");
    state.claimed = [state.rows[0].id];
    expect(await retryDueMails({ onlyBooking: "b1" })).toEqual({ sent: 1, retry: 0, failed: 0 });
    expect(state.rows[0]).toMatchObject({ state: "sent", attempts: 2, last_error: null });
    expect(state.sent).toMatchObject([{ subject: "Confirmed: Bcc: x@example.com", replyTo: "host@example.com", html: "<p>Hello</p>" }]);
    expect(await retryDueMails({ onlyBooking: "b1" })).toEqual({ sent: 0, retry: 0, failed: 0 });
  });

  it("sends a row two overlapping scheduler runs both claimed only once", async () => {
    state.failSends = 1;
    expect(await sendMail(mail())).toBe("retry");
    // Run B claims the row again after run A's lease ran out while A was still busy with its batch.
    state.claimed = [state.rows[0].id];
    const runs = await Promise.all([retryDueMails({ onlyBooking: "b1" }), retryDueMails({ onlyBooking: "b1" })]);
    expect(runs).toEqual([
      { sent: 1, retry: 0, failed: 0 },
      { sent: 0, retry: 0, failed: 0 },
    ]);
    expect(state.sent).toHaveLength(1);
  });

  it("does not send a claimed row once its send_until has passed during the batch", async () => {
    state.failSends = 1;
    expect(await sendMail(mail("reminder:b1", new Date(Date.now() + 86_400_000)))).toBe("retry");
    state.rows[0].send_until = new Date(Date.now() - 1).toISOString();
    state.claimed = [state.rows[0].id];
    expect(await retryDueMails({ onlyBooking: "b1" })).toEqual({ sent: 0, retry: 0, failed: 0 });
    expect(state.sent).toEqual([]);
  });

  it("fails at once when the next attempt would be past send_until", async () => {
    state.failSends = 1;
    expect(await sendMail(mail("reminder:b1", new Date(Date.now() + 30_000)))).toBe("failed");
    expect(state.rows[0]).toMatchObject({ state: "failed", attempts: 1 });
  });
});
