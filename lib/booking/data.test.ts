import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "./token";

// loadContext and loadConfirmation with a stubbed database: which hosts and event type a page gets, and how a token
// finds its booking.

type Result = { data: unknown; error: unknown };
const db = vi.hoisted(() => ({ tables: {} as Record<string, (filters: [string, string, unknown][]) => Result>, queries: [] as [string, [string, string, unknown][]][] }));
vi.mock("@/lib/availability/data", () => ({ loadOffer: async () => ({ slots: [{ start: "s", end: "e", hostIds: ["h1"] }], availability: new Map() }) }));
vi.mock("@/lib/db/admin", () => ({
  createAdminSupabase: () => ({
    from(table: string) {
      const filters: [string, string, unknown][] = [];
      const result = () => {
        db.queries.push([table, filters]);
        return (db.tables[table] ?? (() => ({ data: [], error: null })))(filters);
      };
      const chain: Record<string, unknown> = {
        then: (resolve: (r: Result) => unknown) => resolve(result()),
        maybeSingle: async () => {
          const r = result();
          return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
        },
      };
      for (const method of ["select", "eq", "in", "order", "limit"]) {
        chain[method] = (column: string, value: unknown) => {
          if (method !== "select") filters.push([method, column, value]);
          return chain;
        };
      }
      return chain;
    },
  }),
}));

const { loadBookingPage, loadConfirmation, loadContext } = await import("./data");

const typeId = "00000000-0000-4000-8000-000000000101";
const people = [
  { id: "h1", name: "Alex Host", meet_auto: true, slug: "alex" },
  { id: "h2", name: "Blake Host", meet_auto: false, slug: "blake" },
];
const meeting = { id: typeId, slug: "meeting", title: "Meeting", description: null, duration_minutes: 30, questions: [] };
const has = (filters: [string, string, unknown][], column: string) => filters.find(([m, c]) => m === "eq" && c === column)?.[2];

let settings: Record<string, unknown>;

beforeEach(() => {
  db.queries = [];
  settings = { website_mode: "round_robin", default_event_type_id: typeId };
  db.tables = {
    settings: () => ({ data: Object.entries(settings).map(([key, value]) => ({ key, value })), error: null }),
    event_types: (f) => ({ data: [meeting, { ...meeting, id: "t2", slug: "discovery-call" }].filter((t) => has(f, "id") === t.id || has(f, "slug") === t.slug), error: null }),
    profiles: (f) => ({ data: people.filter((p) => !has(f, "slug") || has(f, "slug") === p.slug), error: null }),
  };
});

describe("loadContext", () => {
  it("gives the general page every active bookable member in round robin, with the default event type", async () => {
    expect(await loadContext({ kind: "page" })).toEqual({
      via: "page",
      hosts: [
        { id: "h1", name: "Alex Host", meetAuto: true },
        { id: "h2", name: "Blake Host", meetAuto: false },
      ],
      eventType: { id: typeId, slug: "meeting", title: "Meeting", description: null, durationMinutes: 30, questions: [] },
    });
    const profiles = db.queries.find(([table]) => table === "profiles")![1];
    expect(profiles).toEqual(expect.arrayContaining([["eq", "active", true], ["eq", "bookable", true]]));
  });

  it("gives the general page only the website person while they can be booked", async () => {
    settings = { ...settings, website_mode: "person", website_person_id: "h2" };
    expect((await loadContext({ kind: "page" }))?.hosts.map((h) => h.id)).toEqual(["h2"]);
    settings.website_person_id = "gone";
    expect((await loadContext({ kind: "page" }))?.hosts.map((h) => h.id)).toEqual(["h1", "h2"]);
  });

  it("gives a member page that member, and null for unknown or malformed slugs", async () => {
    expect(await loadContext({ kind: "person", slug: "blake" })).toMatchObject({ via: "person_link", hosts: [{ id: "h2" }] });
    expect(await loadContext({ kind: "person", slug: "nobody" })).toBeNull();
    const before = db.queries.length;
    expect(await loadContext({ kind: "person", slug: "Blake;drop" })).toBeNull();
    expect(db.queries.length).toBe(before);
  });

  it("takes a chosen active event type by slug, and null when it or the default is missing", async () => {
    expect((await loadContext({ kind: "page", eventType: "discovery-call" }))?.eventType.id).toBe("t2");
    expect(await loadContext({ kind: "page", eventType: "unknown" })).toBeNull();
    expect(await loadContext({ kind: "page", eventType: "../x" })).toBeNull();
    settings = { website_mode: "round_robin" };
    expect(await loadContext({ kind: "page" })).toBeNull();
  });

  it("keeps the general page without hosts when nobody is bookable", async () => {
    db.tables.profiles = () => ({ data: [], error: null });
    expect((await loadContext({ kind: "page" }))?.hosts).toEqual([]);
  });

  it("throws on a database error instead of pretending the page does not exist", async () => {
    db.tables.settings = () => ({ data: null, error: new Error("down") });
    await expect(loadContext({ kind: "page" })).rejects.toThrow("down");
  });
});

describe("loadBookingPage", () => {
  it("sends only start and end of each free time", async () => {
    expect((await loadBookingPage({ kind: "page" }))?.slots).toEqual([{ start: "s", end: "e" }]);
  });
});

describe("loadConfirmation", () => {
  const token = "a".repeat(43);
  const row = {
    id: "b1",
    starts_at: "2026-11-04T09:30:00+00:00",
    ends_at: "2026-11-04T10:00:00+00:00",
    state: "booked",
    meet_url: null,
    invitee_timezone: null,
    profiles: { name: "Alex Host", timezone: "Europe/Berlin" },
    event_types: { title: "Meeting" },
  };

  it("finds the booking by its token hash, in the host's zone when the invitee picked none", async () => {
    db.tables.bookings = (f) => ({ data: has(f, "token_hash") === hashToken(token) ? [row] : [], error: null });
    expect(await loadConfirmation(token)).toEqual({
      bookingId: "b1",
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      timeZone: "Europe/Berlin",
      hostName: "Alex Host",
      eventTitle: "Meeting",
      meetUrl: null,
      state: "booked",
    });
  });

  it("falls back to an extra link token", async () => {
    db.tables.bookings = (f) => ({ data: has(f, "id") === "b1" ? [{ ...row, invitee_timezone: "America/New_York" }] : [], error: null });
    db.tables.booking_tokens = (f) => ({ data: has(f, "token_hash") === hashToken(token) ? [{ booking_id: "b1" }] : [], error: null });
    expect(await loadConfirmation(token)).toMatchObject({ bookingId: "b1", timeZone: "America/New_York" });
    expect(await loadConfirmation("b".repeat(43))).toBeNull();
  });

  it("does not look up implausible tokens", async () => {
    expect(await loadConfirmation("short")).toBeNull();
    expect(await loadConfirmation(undefined)).toBeNull();
    expect(db.queries).toEqual([]);
  });
});
