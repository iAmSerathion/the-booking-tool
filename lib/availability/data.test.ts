import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Access } from "@/lib/google/connection";
import { calendarScope } from "@/lib/google/scopes";

// loadAvailability and loadOffer with a stubbed database, Google token and fetch: which hosts offer slots and what blocks
// them. The slot rules themselves are tested in lib/core/availability.test.ts.

const access = vi.hoisted(() => ({ value: { ok: true, token: "token" } as Access }));
vi.mock("next/cache", () => ({ cacheLife: () => {}, cacheTag: () => {} }));
vi.mock("@/lib/google/connection", () => ({ googleAccess: async () => access.value }));
const admin = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db/admin", () => ({ createAdminSupabase: () => admin.db }));

const { loadAvailability, loadOffer, slotsFor } = await import("./data");

type Result = { data: unknown; error: unknown };
type Tables = Record<string, Result | ((filters: Record<string, unknown>) => Result)>;

// A query builder stand-in: every filter is recorded, awaiting the query or maybeSingle() gives the table's result.
function fakeDb(tables: Tables): SupabaseClient {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const result = () => {
        const entry = tables[table] ?? { data: [], error: null };
        return typeof entry === "function" ? entry(filters) : entry;
      };
      const chain: Record<string, unknown> = {
        then: (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
        maybeSingle: async () => {
          const r = result();
          return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
        },
      };
      for (const method of ["select", "eq", "in", "gt", "gte", "lt"]) {
        chain[method] = (column: string, value: unknown) => {
          if (method !== "select") filters[column] = value;
          return chain;
        };
      }
      return chain;
    },
  } as unknown as SupabaseClient;
}

const allWeek = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_time: "09:00:00", end_time: "17:00:00" }));

function hostTables(id: string, overrides: Tables = {}): Tables {
  return {
    profiles: { data: { timezone: "UTC", buffer_minutes: 0, min_notice_hours: 0, max_bookings_per_day: 20, active: true, bookable: true }, error: null },
    calendar_connections: { data: { scopes: [calendarScope], status: "ok", primary_calendar_id: `${id}@example.com`, busy_calendar_ids: [] }, error: null },
    availability_windows: { data: allWeek, error: null },
    settings: { data: { value: 2 }, error: null },
    bookings: { data: [], error: null },
    slot_holds: { data: [], error: null },
    ...overrides,
  };
}

let busy: Record<string, { start: string; end: string }[]>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-02T08:00:00Z"));
  access.value = { ok: true, token: "token" };
  busy = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const items = (JSON.parse(String(init?.body)).items as { id: string }[]).map(({ id }) => [id, { busy: busy[id] ?? [] }]);
      return new Response(JSON.stringify({ calendars: Object.fromEntries(items) }));
    }),
  );
  for (const [key, value] of Object.entries({
    APP_URL: "https://booking.example.com",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54421",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    SCHEDULER_SECRET: "x".repeat(32),
    SMTP_URL: "smtp://127.0.0.1:2525",
    MAIL_FROM: "bookings@example.com",
  })) {
    vi.stubEnv(key, value);
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const starts = (slots: { start: Date }[], day: string) => slots.filter((s) => s.start.toISOString().startsWith(day)).map((s) => s.start.toISOString().slice(11, 16));

describe("loadAvailability", () => {
  it("combines windows, rules, Google busy, bookings and live holds", async () => {
    busy["a@example.com"] = [{ start: "2026-11-02T09:00:00Z", end: "2026-11-02T10:00:00Z" }];
    const db = fakeDb(
      hostTables("a", {
        bookings: { data: [{ starts_at: "2026-11-02T11:00:00Z", ends_at: "2026-11-02T11:30:00Z" }], error: null },
        slot_holds: { data: [{ starts_at: "2026-11-02T12:00:00Z", ends_at: "2026-11-02T12:30:00Z" }], error: null },
      }),
    );
    const availability = await loadAvailability(db, "a", { fresh: true });
    expect(availability).toMatchObject({ state: "ok", timeZone: "UTC", primaryCalendarId: "a@example.com" });
    if (availability.state !== "ok") return;
    expect(availability.input.horizonDays).toBe(2);
    expect(availability.input.bookings).toHaveLength(1);
    expect(availability.input.busy).toHaveLength(2);
    expect(starts(slotsFor(availability, 30), "2026-11-02")).toEqual(["10:00", "10:30", "11:30", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30"]);
    expect(starts(slotsFor(availability, 30), "2026-11-05")).toEqual([]);
  });

  it("queries only the host's booked bookings and live holds", async () => {
    const seen: Record<string, Record<string, unknown>> = {};
    const record = (table: string) => (filters: Record<string, unknown>) => ((seen[table] = filters), { data: [], error: null });
    await loadAvailability(fakeDb(hostTables("a", { bookings: record("bookings"), slot_holds: record("slot_holds") })), "a", { fresh: true });
    expect(seen.bookings).toMatchObject({ host_id: "a", state: "booked", starts_at: "2026-11-05T00:00:00.000Z" });
    expect(seen.slot_holds).toMatchObject({ host_id: "a", expires_at: "2026-11-02T08:00:00.000Z" });
  });

  it("a host who is inactive or not bookable offers nothing", async () => {
    const profile = (more: object) => ({ data: { timezone: "UTC", buffer_minutes: 0, min_notice_hours: 0, max_bookings_per_day: 3, active: true, bookable: true, ...more }, error: null });
    expect(await loadAvailability(fakeDb(hostTables("a", { profiles: profile({ bookable: false }) })), "a")).toEqual({ state: "not_bookable" });
    expect(await loadAvailability(fakeDb(hostTables("a", { profiles: profile({ active: false }) })), "a")).toEqual({ state: "not_bookable" });
    expect(await loadAvailability(fakeDb(hostTables("a", { profiles: { data: null, error: null } })), "a")).toEqual({ state: "not_bookable" });
  });

  it("a host without a working calendar connection offers nothing", async () => {
    const connection = (more: object) => ({ data: { scopes: [calendarScope], status: "ok", primary_calendar_id: "a@example.com", busy_calendar_ids: [], ...more }, error: null });
    expect(await loadAvailability(fakeDb(hostTables("a", { calendar_connections: { data: null, error: null } })), "a")).toEqual({ state: "no_calendar" });
    expect(await loadAvailability(fakeDb(hostTables("a", { calendar_connections: connection({ scopes: [] }) })), "a")).toEqual({ state: "no_calendar" });
    expect(await loadAvailability(fakeDb(hostTables("a", { calendar_connections: connection({ primary_calendar_id: null }) })), "a")).toEqual({ state: "no_calendar" });
    expect(await loadAvailability(fakeDb(hostTables("a", { calendar_connections: connection({ status: "needs_reconnect" }) })), "a")).toEqual({ state: "needs_reconnect" });
    access.value = { ok: false, reason: "needs_reconnect" };
    expect(await loadAvailability(fakeDb(hostTables("a")), "a", { fresh: true })).toEqual({ state: "needs_reconnect" });
    access.value = { ok: false, reason: "not_connected" };
    expect(await loadAvailability(fakeDb(hostTables("a")), "a", { fresh: true })).toEqual({ state: "no_calendar" });
  });

  it("Google or the database failing makes the host unavailable, never free", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ calendars: {} }))));
    expect(await loadAvailability(fakeDb(hostTables("a")), "a", { fresh: true })).toEqual({ state: "unavailable" });
    expect(await loadAvailability(fakeDb(hostTables("a", { bookings: { data: null, error: { message: "down" } } })), "a")).toEqual({ state: "unavailable" });
    expect(await loadAvailability(fakeDb(hostTables("a", { profiles: { data: null, error: { message: "down" } } })), "a")).toEqual({ state: "unavailable" });
  });

  it("an unknown profile time zone makes the host unavailable instead of throwing", async () => {
    const profiles = { data: { timezone: "Mars/Base", buffer_minutes: 0, min_notice_hours: 0, max_bookings_per_day: 3, active: true, bookable: true }, error: null };
    expect(await loadAvailability(fakeDb(hostTables("a", { profiles })), "a")).toEqual({ state: "unavailable" });
  });

  it("reads the events of extra busy calendars, skipping ones Google cannot read", async () => {
    const connection = { data: { scopes: [calendarScope], status: "ok", primary_calendar_id: "a@example.com", busy_calendar_ids: ["team@example.com", "gone@example.com"] }, error: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/freeBusy")) {
          const ids = (JSON.parse(String(init?.body)).items as { id: string }[]).map(({ id }) => id);
          return new Response(JSON.stringify({ calendars: Object.fromEntries(ids.map((id) => [id, id === "gone@example.com" ? { errors: [{}] } : { busy: [] }])) }));
        }
        if (url.includes("gone%40example.com")) return new Response("{}", { status: 404 });
        // An all-day event marked free, which free/busy would not report.
        return new Response(JSON.stringify({ items: [{ status: "confirmed", start: { date: "2026-11-03" }, end: { date: "2026-11-04" } }] }));
      }),
    );
    const availability = await loadAvailability(fakeDb(hostTables("a", { calendar_connections: connection })), "a", { fresh: true });
    if (availability.state !== "ok") throw new Error(availability.state);
    expect(starts(slotsFor(availability, 30), "2026-11-03")).toEqual([]);
    expect(starts(slotsFor(availability, 30), "2026-11-04")).toHaveLength(16);
  });
});

describe("loadOffer", () => {
  it("merges the hosts' slots by start and leaves out hosts without slots", async () => {
    busy["b@example.com"] = [{ start: "2026-11-02T00:00:00Z", end: "2026-11-02T12:00:00Z" }];
    const tables: Record<string, Tables> = {
      a: hostTables("a"),
      b: hostTables("b"),
      c: hostTables("c", { calendar_connections: { data: null, error: null } }),
    };
    // Each host's queries are answered from its own tables, picked by the id filter; settings are shared.
    admin.db = {
      from: (table: string) => {
        let id = "";
        const chain = fakeDb(
          Object.fromEntries(Object.keys(tables.a).map((name) => [name, () => tables[id || "a"][name] as Result])),
        ).from(table) as unknown as Record<string, (...args: unknown[]) => unknown>;
        const eq = chain.eq;
        chain.eq = (column: unknown, value: unknown) => {
          if (column === "id" || column === "user_id" || column === "host_id") id = String(value);
          return eq(column, value);
        };
        return chain;
      },
    };
    const { slots, availability } = await loadOffer(["a", "b", "c"], 60, { fresh: true });
    expect(availability.get("c")).toEqual({ state: "no_calendar" });
    const today = slots.filter((s) => s.start.startsWith("2026-11-02"));
    expect(today[0]).toEqual({ start: "2026-11-02T09:00:00.000Z", end: "2026-11-02T10:00:00.000Z", hostIds: ["a"] });
    expect(today.find((s) => s.start === "2026-11-02T12:00:00.000Z")?.hostIds).toEqual(["a", "b"]);
    expect(slots.map((s) => s.start)).toEqual([...slots.map((s) => s.start)].sort());
  });
});
