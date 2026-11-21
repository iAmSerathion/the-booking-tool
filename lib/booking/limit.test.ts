import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ headers: new Headers(), trust: false, counts: new Map<string, number>(), fail: false }));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
// The booking_attempt function: counts per hash, refuses at the limit.
vi.mock("@/lib/db/admin", () => ({
  createAdminSupabase: () => ({
    rpc: async (_name: string, args: { p_ip_hash: string; p_limit: number }) => {
      if (state.fail) return { data: null, error: { message: "down" } };
      const used = state.counts.get(args.p_ip_hash) ?? 0;
      if (used >= args.p_limit) return { data: false, error: null };
      state.counts.set(args.p_ip_hash, used + 1);
      return { data: true, error: null };
    },
  }),
}));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ trustProxyHeaders: state.trust, bookingAttemptsPerMinute: 3, schedulerSecret: "s".repeat(32) }) }));
const { clientAddress, limitBuckets, withinBookingLimit, withinLimit } = await import("./limit");

describe("clientAddress", () => {
  const forwarded = new Headers({ "x-forwarded-for": "198.51.100.1, 203.0.113.7", "x-real-ip": "198.51.100.9" });

  it("ignores proxy headers unless they are trusted", () => {
    expect(clientAddress(forwarded, false)).toBeNull();
  });

  it("takes the rightmost X-Forwarded-For hop, which the trusted proxy appended", () => {
    expect(clientAddress(forwarded, true)).toBe("203.0.113.7");
    expect(clientAddress(new Headers({ "x-forwarded-for": " 203.0.113.7 ,, " }), true)).toBe("203.0.113.7");
  });

  it("has no address without the header", () => {
    expect(clientAddress(new Headers(), true)).toBeNull();
  });
});

describe("limitBuckets", () => {
  it("limits a trusted address on its own", () => {
    expect(limitBuckets("203.0.113.7", "a@example.com", 10)).toEqual([{ key: "ip:203.0.113.7", limit: 10 }]);
  });

  it("without an address limits per normalised email, with a much higher global ceiling", () => {
    expect(limitBuckets(null, "  Ada@Example.com ", 10)).toEqual([
      { key: "email:ada@example.com", limit: 10 },
      { key: "global", limit: 200 },
    ]);
    expect(limitBuckets(null, 42, 10)[0].key).toBe("email:");
  });
});

describe("withinLimit without a trusted proxy", () => {
  beforeEach(() => {
    state.counts.clear();
    state.fail = false;
    state.headers = new Headers();
    state.trust = false;
  });

  it("stops one email at its limit without blocking another", async () => {
    for (let i = 0; i < 3; i++) expect(await withinLimit("junk@example.com")).toBe(true);
    expect(await withinLimit("junk@example.com")).toBe(false);
    expect(await withinLimit("JUNK@example.com ")).toBe(false);
    expect(await withinLimit("real@example.com")).toBe(true);
  });

  it("stops everyone at the global ceiling, which is 20 times the limit", async () => {
    let allowed = 0;
    for (let i = 0; i < 100; i++) if (await withinLimit(`user${i}@example.com`)) allowed++;
    expect(allowed).toBe(60);
  });

  it("limits a trusted address regardless of the email, and fails closed on a database error", async () => {
    state.trust = true;
    state.headers = new Headers({ "x-forwarded-for": "203.0.113.7" });
    for (let i = 0; i < 3; i++) expect(await withinLimit(`user${i}@example.com`)).toBe(true);
    expect(await withinLimit("another@example.com")).toBe(false);
    state.headers = new Headers({ "x-forwarded-for": "203.0.113.8" });
    expect(await withinLimit("another@example.com")).toBe(true);
    state.fail = true;
    expect(await withinLimit("x@example.com")).toBe(false);
  });
});

describe("withinBookingLimit", () => {
  beforeEach(() => {
    state.counts.clear();
    state.fail = false;
    state.headers = new Headers();
    state.trust = false;
  });

  it("is not blocked when someone fills the invitee's email bucket and the global bucket through bookSlot", async () => {
    while (await withinLimit("victim@example.com"));
    for (let i = 0; i < 100; i++) await withinLimit(`flood${i}@example.com`);
    expect(await withinLimit("someone@example.com")).toBe(false);
    expect(await withinBookingLimit("booking-1")).toBe(true);
  });

  it("caps each booking on its own, and fails closed on a database error", async () => {
    for (let i = 0; i < 3; i++) expect(await withinBookingLimit("booking-1")).toBe(true);
    expect(await withinBookingLimit("booking-1")).toBe(false);
    expect(await withinBookingLimit("booking-2")).toBe(true);
    state.fail = true;
    expect(await withinBookingLimit("booking-3")).toBe(false);
  });
});
