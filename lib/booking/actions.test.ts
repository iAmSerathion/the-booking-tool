import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Availability, SlotOffer } from "@/lib/availability/data";
import type { BookingContext } from "./data";
import { hashToken } from "./token";

// The booking action's orchestration with the database, Google and availability stubbed: bot check, rate limit,
// validation, the fresh re-check, round robin, hold, event, create_booking and the rollback order. hold_slot and
// create_booking themselves are tested against Postgres in tests/db/bookings.test.ts.

const state = vi.hoisted(() => ({
  limitOk: true,
  context: null as unknown,
  offer: { slots: [] as SlotOffer[], availability: new Map<string, Availability>() },
  last: new Map<string, string | null>(),
  access: new Map<string, boolean>(),
  upcoming: [] as unknown[],
  template: null as unknown,
  holds: new Map<string, string | null>(),
  createBooking: [] as ({ code: string; message: string } | null)[],
  insertFails: false,
  calls: [] as [string, ...unknown[]][],
}));

vi.mock("next/cache", () => ({ updateTag: (tag: string) => state.calls.push(["updateTag", tag]) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    state.calls.push(["redirect", url]);
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("./limit", () => ({ withinLimit: async () => (state.calls.push(["limit"]), state.limitOk) }));
vi.mock("./data", async (importActual) => ({
  ...(await importActual<typeof import("./data")>()),
  loadContext: async () => state.context,
  lastRoundRobinBookings: async () => state.last,
}));
vi.mock("@/lib/availability/data", () => ({
  busyCacheTag: (id: string) => `google-busy-${id}`,
  loadOffer: async (...args: unknown[]) => (state.calls.push(["loadOffer", ...args]), state.offer),
}));
vi.mock("@/lib/google/connection", () => ({
  googleAccess: async (id: string) => (state.access.get(id) === false ? { ok: false, reason: "unavailable" } : { ok: true, token: `token-${id}` }),
}));
vi.mock("@/lib/google/calendar", () => ({
  createEvent: async (...args: unknown[]) => {
    state.calls.push(["createEvent", ...args]);
    if (state.insertFails) throw new Error("Google down");
    return { id: "event-1", meetUrl: (args[2] as { meet: boolean }).meet ? "https://meet.google.com/x" : null };
  },
  deleteEvent: async (...args: unknown[]) => state.calls.push(["deleteEvent", ...args]),
  googleEventId: (id: string) => id.replace(/-/g, ""),
}));
vi.mock("@/lib/db/admin", () => ({
  createAdminSupabase: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        then: (resolve: (r: unknown) => unknown) => resolve({ data: table === "bookings" ? state.upcoming : [], error: null }),
        maybeSingle: async () => ({ data: state.template === null ? null : { value: state.template }, error: null }),
      };
      for (const method of ["select", "eq", "gt", "limit"]) chain[method] = () => chain;
      return chain;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.calls.push([name, args]);
      if (name === "hold_slot") return { data: state.holds.get(args.p_host_id as string) ?? null, error: null };
      if (name === "create_booking") return { data: "id", error: state.createBooking.shift() ?? null };
      return { data: null, error: null };
    },
  }),
}));

const { bookSlot } = await import("./actions");

const start = "2026-11-04T09:30:00.000Z";
const end = "2026-11-04T10:00:00.000Z";
const later = "2026-11-04T13:00:00.000Z";
const ok = (primary: string): Availability => ({
  state: "ok",
  timeZone: "Europe/Berlin",
  primaryCalendarId: primary,
  input: {
    windows: [],
    timeZone: "Europe/Berlin",
    busy: [],
    bookings: [],
    bufferMinutes: 15,
    minNoticeHours: 0,
    maxBookingsPerDay: 3,
    horizonDays: 14,
    now: new Date(),
  },
});
const context: BookingContext = {
  via: "page",
  hosts: [
    { id: "h1", name: "Alex Host", meetAuto: true },
    { id: "h2", name: "Blake Host", meetAuto: false },
  ],
  eventType: {
    id: "type-1",
    slug: "discovery-call",
    title: "Discovery call",
    description: null,
    durationMinutes: 30,
    questions: [{ id: "topic", label: "Topic?", type: "choice", choices: ["Pricing", "Other"], required: true }],
  },
};
const form = (extra: Record<string, unknown> = {}) => ({
  name: " Ada  Example ",
  email: "Ada@Example.com",
  company: "",
  phone: "",
  topic: "",
  privacy: true,
  answers: { topic: "Pricing" },
  start,
  timeZone: "America/New_York",
  honeypot: "",
  startedAt: Date.now() - 5000,
  ...extra,
});
const called = (name: string) => state.calls.filter((c) => c[0] === name);
const names = () => state.calls.map((c) => c[0]);

async function book(extra: Record<string, unknown> = {}) {
  try {
    return await bookSlot({ kind: "page" }, form(extra));
  } catch (cause) {
    if ((cause as Error).message !== "NEXT_REDIRECT") throw cause;
    return "redirected" as const;
  }
}

beforeEach(() => {
  vi.unstubAllEnvs();
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
    DEFAULT_LOCALE: "en",
    PRIVACY_URL: "https://example.com/privacy",
  }))
    vi.stubEnv(key, value);
  vi.spyOn(console, "error").mockImplementation(() => {});
  Object.assign(state, {
    limitOk: true,
    context,
    offer: {
      slots: [
        { start, end, hostIds: ["h1", "h2"] },
        { start: later, end: "2026-11-04T13:30:00.000Z", hostIds: ["h2"] },
      ],
      availability: new Map([
        ["h1", ok("h1@example.com")],
        ["h2", ok("h2@example.com")],
      ]),
    },
    // h1 had a page booking more recently, so h2 is next.
    last: new Map([
      ["h1", "2026-11-01T10:00:00Z"],
      ["h2", "2026-10-01T10:00:00Z"],
    ]),
    access: new Map(),
    upcoming: [],
    template: null,
    holds: new Map([
      ["h1", "hold-1"],
      ["h2", "hold-2"],
    ]),
    createBooking: [],
    insertFails: false,
    calls: [],
  });
});

describe("bookSlot", () => {
  it("books the round robin host: hold, Google event, create_booking, cache tag, redirect", async () => {
    expect(await book()).toBe("redirected");
    expect(names()).toEqual(["limit", "loadOffer", "hold_slot", "createEvent", "create_booking", "updateTag", "redirect"]);
    expect(called("loadOffer")[0]).toEqual(["loadOffer", ["h1", "h2"], 30, { fresh: true }]);
    expect(called("hold_slot")[0][1]).toEqual({
      p_host_id: "h2",
      p_starts_at: start,
      p_ends_at: end,
      p_buffer_minutes: 15,
      p_max_per_day: 3,
      // The host's day in Europe/Berlin (UTC+1 in November).
      p_day_from: "2026-11-03T23:00:00.000Z",
      p_day_to: "2026-11-04T23:00:00.000Z",
    });

    const token = (called("redirect")[0][1] as string).match(/^\/confirmed\/([A-Za-z0-9_-]{43})\?new=1$/)![1];
    const [, accessToken, calendarId, event] = called("createEvent")[0] as [string, string, string, Record<string, unknown>];
    expect([accessToken, calendarId]).toEqual(["token-h2", "h2@example.com"]);
    expect(event).toMatchObject({
      summary: "Discovery call: Ada Example and Blake Host",
      description: `Booking details: https://booking.example.com/confirmed/${token}`,
      timeZone: "Europe/Berlin",
      attendees: [{ email: "Ada@Example.com", displayName: "Ada Example" }],
      meet: false,
    });
    expect(JSON.stringify(event)).not.toContain("Pricing");

    const booking = (called("create_booking")[0][1] as { p_hold_id: string; p_booking: Record<string, unknown> });
    expect(booking.p_hold_id).toBe("hold-2");
    expect(booking.p_booking).toMatchObject({
      id: event.bookingId,
      event_type_id: "type-1",
      host_id: "h2",
      starts_at: start,
      ends_at: end,
      booked_via: "page",
      invitee_name: "Ada Example",
      invitee_timezone: "America/New_York",
      answers: [{ id: "topic", question: "Topic?", answer: "Pricing" }],
      google_event_id: "event-1",
      meet_url: null,
      token_hash: hashToken(token),
      check_upcoming: true,
      link_id: null,
      widget_id: null,
    });
    expect(called("updateTag")[0][1]).toBe("google-busy-h2");
  });

  it("books through a link with its host, via link and the link id from the server-side context", async () => {
    state.context = { ...context, via: "link", hosts: [context.hosts[0]], linkId: "link-1", prefill: { name: "Ada" } };
    expect(await book({ link_id: "forged", linkId: "forged" })).toBe("redirected");
    expect(called("create_booking")[0][1]).toMatchObject({ p_hold_id: "hold-1", p_booking: { host_id: "h1", booked_via: "link", link_id: "link-1" } });
  });

  it("answers a link that closed after the page loaded with linkInvalid, before any hold", async () => {
    state.context = null;
    expect(await bookSlot({ kind: "link", token: "a".repeat(43) }, form())).toEqual({ ok: false, error: "booking.error.linkInvalid" });
    expect(names()).toEqual(["limit"]);
  });

  it("books through a widget with the widget id from the server-side context and stays inside the frame", async () => {
    const id = "00000000-0000-4000-8000-000000000201";
    state.context = { ...context, via: "widget", widgetId: id };
    for (const view of ["window", "section"] as const) {
      state.calls = [];
      await expect(bookSlot({ kind: "widget", id, view }, form({ widget_id: "forged", widgetId: "forged" }))).rejects.toThrow("NEXT_REDIRECT");
      expect(called("create_booking")[0][1]).toMatchObject({ p_booking: { booked_via: "widget", widget_id: id, link_id: null } });
      const path = view === "section" ? `/widget/${id}/section` : `/widget/${id}`;
      expect(called("redirect")[0][1]).toMatch(new RegExp(`^${path}/confirmed/[A-Za-z0-9_-]{43}\\?new=1$`));
    }
  });

  it("stores a widget's booking page only from one of the widget's origins, and never for other channels", async () => {
    const id = "00000000-0000-4000-8000-000000000201";
    state.context = { ...context, via: "widget", widgetId: id, embedOrigins: ["https://example.com"] };
    const cases: [unknown, string | null][] = [
      ["https://example.com/pricing", "https://example.com/pricing"],
      ["https://evil.example/pricing", null],
      ["https://example.com/pricing?x=1", null],
      [42, null],
    ];
    for (const [bookingPage, stored] of cases) {
      state.calls = [];
      await expect(bookSlot({ kind: "widget", id, view: "section" }, form({ bookingPage }))).rejects.toThrow("NEXT_REDIRECT");
      expect(called("create_booking")[0][1]).toMatchObject({ p_booking: { booking_page: stored } });
    }
    state.context = context;
    state.calls = [];
    await expect(bookSlot({ kind: "person", slug: "ada" }, form({ bookingPage: "https://example.com/pricing" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(called("create_booking")[0][1]).toMatchObject({ p_booking: { booking_page: null } });
  });

  it("answers a widget switched off after the page loaded with widgetClosed, before any hold", async () => {
    state.context = null;
    expect(await bookSlot({ kind: "widget", id: "00000000-0000-4000-8000-000000000201", view: "window" }, form())).toEqual({ ok: false, error: "booking.error.widgetClosed" });
    expect(names()).toEqual(["limit"]);
  });

  it("answers a used or revoked link (P0004) with linkInvalid", async () => {
    state.context = { ...context, via: "link", hosts: [context.hosts[0]], linkId: "link-1" };
    state.createBooking = [{ code: "P0004", message: "The booking link is no longer valid." }];
    expect(await book()).toEqual({ ok: false, error: "booking.error.linkInvalid" });
    expect(names()).toContain("release_hold");
  });

  it("uses the summary template from settings and Meet when the host has it on", async () => {
    state.template = "Call with {invitee} ({event}) {brand}";
    state.last = new Map();
    expect(await book()).toBe("redirected");
    expect(called("createEvent")[0][3]).toMatchObject({ summary: "Call with Ada Example (Discovery call) {brand}", meet: true });
    expect(called("create_booking")[0][1]).toMatchObject({ p_booking: { host_id: "h1", meet_url: "https://meet.google.com/x" } });
  });

  it("treats a fast or honeypot submit as a bot, without counting an attempt", async () => {
    expect(await book({ startedAt: Date.now() - 500 })).toEqual({ ok: false, error: "booking.error.failed" });
    expect(await book({ honeypot: "https://spam.example.com" })).toEqual({ ok: false, error: "booking.error.failed" });
    expect(await book({ startedAt: "soon" })).toEqual({ ok: false, error: "booking.error.failed" });
    expect(state.calls).toEqual([]);
  });

  it("stops at the rate limit", async () => {
    state.limitOk = false;
    expect(await book()).toEqual({ ok: false, error: "booking.error.tooMany" });
    expect(names()).toEqual(["limit"]);
  });

  it("returns field and answer errors as message keys before anything is held", async () => {
    expect(await book({ name: " ", email: "nope", privacy: false, answers: { topic: "Hacking" } })).toEqual({
      ok: false,
      fieldErrors: {
        name: "booking.error.name",
        email: "booking.error.emailInvalid",
        privacy: "booking.error.privacy",
        "answers.topic": "booking.error.answerInvalid",
      },
    });
    expect(await book({ answers: {} })).toEqual({ ok: false, fieldErrors: { "answers.topic": "booking.error.answerRequired" } });
    expect(names()).toEqual(["limit", "limit"]);
  });

  it("does not require the privacy box without a privacy URL", async () => {
    vi.stubEnv("PRIVACY_URL", "");
    vi.resetModules();
    const { bookSlot: fresh } = await import("./actions");
    await expect(fresh({ kind: "page" }, form({ privacy: false }))).rejects.toThrow("NEXT_REDIRECT");
  });

  it("refuses a second upcoming booking of the same event type before Google is asked, like any other failure", async () => {
    state.upcoming = [{ id: "b0" }];
    expect(await book()).toEqual({ ok: false, error: "booking.error.failed" });
    expect(names()).toEqual(["limit", "loadOffer"]);
  });

  it("does not reveal an existing booking for a start that is not offered", async () => {
    state.upcoming = [{ id: "b0" }];
    const unknown = await book({ start: "1970-01-01T00:00:00.000Z" });
    state.upcoming = [];
    expect(unknown).toMatchObject({ ok: false, error: "booking.error.taken" });
    expect(await book({ start: "1970-01-01T00:00:00.000Z" })).toEqual(unknown);
  });

  it("answers taken with the fresh free times when the start is no longer free", async () => {
    expect(await book({ start: "2026-11-04T11:00:00.000Z" })).toEqual({
      ok: false,
      error: "booking.error.taken",
      slots: [
        { start, end },
        { start: later, end: "2026-11-04T13:30:00.000Z" },
      ],
    });
    expect(await book({ start: "yesterday" })).toEqual({ ok: false, error: "booking.error.taken" });
    expect(names()).not.toContain("hold_slot");
  });

  it("fails without a context and offers nothing without hosts", async () => {
    state.context = null;
    expect(await book()).toEqual({ ok: false, error: "booking.error.failed" });
    state.context = { ...context, hosts: [] };
    expect(await book()).toEqual({ ok: false, error: "booking.error.taken", slots: [] });
  });

  it("falls back to the next host when the first hold fails or Google access is gone", async () => {
    state.holds.set("h2", null);
    expect(await book()).toBe("redirected");
    expect(called("create_booking")[0][1]).toMatchObject({ p_hold_id: "hold-1", p_booking: { host_id: "h1" } });

    state.calls = [];
    state.holds.set("h2", "hold-2");
    state.access.set("h2", false);
    expect(await book()).toBe("redirected");
    expect(names()).toEqual(["limit", "loadOffer", "hold_slot", "release_hold", "hold_slot", "createEvent", "create_booking", "updateTag", "redirect"]);
    expect(called("release_hold")[0][1]).toEqual({ p_hold_id: "hold-2" });
  });

  it("answers taken, without the start, when every hold fails", async () => {
    state.holds = new Map();
    expect(await book()).toEqual({ ok: false, error: "booking.error.taken", slots: [{ start: later, end: "2026-11-04T13:30:00.000Z" }] });
  });

  it("releases the hold and saves nothing when the Google event fails", async () => {
    state.insertFails = true;
    expect(await book()).toEqual({ ok: false, error: "booking.error.failed" });
    expect(names()).toEqual(["limit", "loadOffer", "hold_slot", "createEvent", "deleteEvent", "release_hold"]);
  });

  it("takes a possibly created event back, by the id derived from the booking, when the insert response is lost", async () => {
    state.insertFails = true;
    await book();
    const [, , , event] = called("createEvent")[0] as [string, string, string, { bookingId: string }];
    expect(called("deleteEvent")).toEqual([["deleteEvent", "token-h2", "h2@example.com", event.bookingId.replace(/-/g, ""), "none"]]);
    expect(names()).toEqual(["limit", "loadOffer", "hold_slot", "createEvent", "deleteEvent", "release_hold"]);
  });

  it.each([
    ["P0002", { ok: false, error: "booking.error.taken", slots: [{ start: later, end: "2026-11-04T13:30:00.000Z" }] }],
    ["P0003", { ok: false, error: "booking.error.failed" }],
    ["P0004", { ok: false, error: "booking.error.linkInvalid" }],
    ["XX000", { ok: false, error: "booking.error.failed" }],
  ])("rolls back the event quietly and releases the hold when create_booking fails with %s", async (code, result) => {
    state.createBooking = [{ code, message: "no" }];
    expect(await book()).toEqual(result);
    expect(names()).toEqual(["limit", "loadOffer", "hold_slot", "createEvent", "create_booking", "deleteEvent", "release_hold"]);
    expect(called("deleteEvent")[0]).toEqual(["deleteEvent", "token-h2", "h2@example.com", "event-1", "none"]);
  });
});
