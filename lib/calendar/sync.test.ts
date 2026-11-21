import { beforeEach, describe, expect, it, vi } from "vitest";

// syncCalendar with the database, Google and the mails stubbed: which RPCs and mails each event leads to, and when the
// sync token is kept. The SQL behind the RPCs is tested against Postgres in tests/db.

const user = "00000000-0000-4000-8000-0000000000a1";
const now = new Date("2030-01-02T08:00:00Z");
const start = "2030-01-04T09:30:00.000Z";
const end = "2030-01-04T10:15:00.000Z";

const state = vi.hoisted(() => ({
  claims: [] as unknown[],
  again: [] as boolean[],
  pages: [] as (unknown[] | Error)[],
  rows: [] as Record<string, unknown>[],
  calls: [] as unknown[][],
  failRpc: new Set<string>(),
  cancelError: null as { code: string } | null,
}));

vi.mock("@/lib/google/connection", () => ({ googleAccess: async () => ({ ok: true, token: "access" }) }));
vi.mock("@/lib/google/calendar", () => ({
  listEventChanges: async (_token: string, calendarId: string, p: { syncToken: string | null }) => {
    state.calls.push(["list", calendarId, p.syncToken]);
    const next = state.pages.shift() ?? [];
    if (next instanceof Error) throw next;
    return { events: next, nextSyncToken: `next-${state.calls.length}` };
  },
}));
vi.mock("@/lib/jobs/plan", () => ({ planBookingJobs: async (id: string) => state.calls.push(["plan", id]) }));
vi.mock("@/lib/booking/google", () => ({ removeBookingEvent: async (host: string, event: string) => (state.calls.push(["removeEvent", host, event]), true) }));
vi.mock("@/lib/mail/booking", () => ({
  sendCalendarMoveMail: async (id: string, before: unknown) => state.calls.push(["moveMail", id, before]),
  sendCancelMails: async (id: string, options: unknown) => state.calls.push(["cancelMails", id, options]),
}));
vi.mock("@/lib/db/admin", () => ({
  createAdminSupabase: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "calendar_sync_claim") return { data: state.claims.shift() ?? null, error: null };
      state.calls.push([name, args]);
      if (name === "calendar_sync_release") return { data: state.again.shift() ?? false, error: null };
      if (state.failRpc.has(name)) return { data: null, error: { code: "XX000", message: "down" } };
      if (name === "cancel_booking") return { data: null, error: state.cancelError };
      return { data: true, error: null };
    },
    from: () => ({ select: () => ({ eq: () => ({ in: async (_column: string, ids: string[]) => ({ data: state.rows.filter((r) => ids.includes(r.google_event_id as string)), error: null }) }) }) }),
  }),
}));

const { GoogleError } = await import("@/lib/google/oauth");
const { syncCalendar } = await import("./sync");

const row = (patch: Record<string, unknown> = {}) => ({
  id: "b1",
  host_id: user,
  state: "booked",
  starts_at: start,
  ends_at: end,
  invitee_email: "sam@example.com",
  guest_responses: { "sam@example.com": "needsAction" },
  google_change_until: null,
  google_event_id: "ev1",
  ...patch,
});
const event = (patch: Record<string, unknown> = {}) => ({
  id: "ev1",
  status: "confirmed",
  start: { dateTime: start },
  end: { dateTime: end },
  attendees: [{ email: "sam@example.com", responseStatus: "needsAction" }],
  ...patch,
});
const sync = () => syncCalendar(user, { now: () => now });
const release = () => state.calls.filter((c) => c[0] === "calendar_sync_release").map((c) => c[1]);
const actions = () => state.calls.filter((c) => !["list", "calendar_sync_release"].includes(c[0] as string));

beforeEach(() => {
  state.claims = [{ sync_token: "old", primary_calendar_id: "host@example.com" }];
  state.again = [];
  state.pages = [];
  state.rows = [row()];
  state.calls = [];
  state.failRpc = new Set();
  state.cancelError = null;
});

describe("syncCalendar", () => {
  it("moved: updates the booking, re-plans the reminders, tells the invitee, and saves the new token", async () => {
    state.pages = [[event({ start: { dateTime: "2030-01-05T09:30:00Z" }, end: { dateTime: "2030-01-05T10:15:00Z" } })]];
    expect(await sync()).toBe("synced");
    expect(actions()).toEqual([
      ["calendar_booking_update", { p_booking_id: "b1", p_plan: { moved: { starts_at: "2030-01-05T09:30:00.000Z", ends_at: "2030-01-05T10:15:00.000Z" } } }],
      ["plan", "b1"],
      ["moveMail", "b1", { startsAt: new Date(start), endsAt: new Date(end) }],
    ]);
    expect(release()).toEqual([{ p_user_id: user, p_sync_token: "next-1", p_save_token: true }]);
  });

  it("guest declined: cancelled by the invitee, event removed, both sides told", async () => {
    state.pages = [[event({ attendees: [{ email: "sam@example.com", responseStatus: "declined" }] })]];
    await sync();
    expect(actions()).toEqual([
      ["cancel_booking", { p_booking_id: "b1", p_cancelled_by: "invitee", p_reason: null }],
      ["removeEvent", user, "ev1"],
      ["cancelMails", "b1", { by: "invitee", reason: null, notifyHost: true }],
    ]);
  });

  it("guest declined a booking that is no longer open (P0002): nothing more", async () => {
    state.cancelError = { code: "P0002" };
    state.pages = [[event({ attendees: [{ email: "sam@example.com", responseStatus: "declined" }] })]];
    await sync();
    expect(actions()).toEqual([["cancel_booking", { p_booking_id: "b1", p_cancelled_by: "invitee", p_reason: null }]]);
    expect(release()[0]).toMatchObject({ p_save_token: true });
  });

  it("host deleted: cancelled by the host, only the invitee told", async () => {
    state.pages = [[{ id: "ev1", status: "cancelled" }]];
    await sync();
    expect(actions()).toEqual([
      ["calendar_booking_deleted", { p_booking_id: "b1" }],
      ["cancelMails", "b1", { by: "host", reason: null, notifyHost: false }],
    ]);
  });

  it("only responses changed: stored, nothing else", async () => {
    state.pages = [[event({ attendees: [{ email: "sam@example.com", responseStatus: "accepted" }] })]];
    await sync();
    expect(actions()).toEqual([["calendar_booking_update", { p_booking_id: "b1", p_plan: { responses: { "sam@example.com": "accepted" } } }]]);
  });

  it("skips events the database does not know, tool-created ones from another install included", async () => {
    state.pages = [[event({ id: "foreign", status: "cancelled" }), event({ id: "other", extendedProperties: { private: { booking_id: "b1" } }, start: { dateTime: "2030-01-09T09:00:00Z" } })]];
    await sync();
    expect(actions()).toEqual([]);
    expect(release()[0]).toMatchObject({ p_save_token: true });
  });

  it("skips the event of another host's booking", async () => {
    state.rows = [row({ host_id: "00000000-0000-4000-8000-0000000000b2" })];
    state.pages = [[{ id: "ev1", status: "cancelled" }]];
    await sync();
    expect(actions()).toEqual([]);
  });

  it("deferred during a change: nothing applied for that booking, the old token kept; the others still apply", async () => {
    state.rows = [row({ google_change_until: new Date(now.getTime() + 60_000).toISOString() }), row({ id: "b2", google_event_id: "ev2" })];
    state.pages = [[event({ start: { dateTime: "2030-01-05T09:30:00Z" } }), { id: "ev2", status: "cancelled" }]];
    expect(await sync()).toBe("synced");
    expect(actions().map((c) => c[0])).toEqual(["calendar_booking_deleted", "cancelMails"]);
    expect(release()).toEqual([{ p_user_id: user, p_sync_token: "next-1", p_save_token: false }]);
  });

  it("a failing event stops neither the others nor the token", async () => {
    state.failRpc.add("calendar_booking_deleted");
    state.rows = [row(), row({ id: "b2", google_event_id: "ev2" })];
    state.pages = [[{ id: "ev1", status: "cancelled" }, event({ id: "ev2", attendees: [{ email: "sam@example.com", responseStatus: "accepted" }] })]];
    vi.spyOn(console, "error").mockImplementation(() => {});
    await sync();
    expect(actions().map((c) => c[0])).toEqual(["calendar_booking_deleted", "calendar_booking_update"]);
    expect(release()[0]).toMatchObject({ p_save_token: true });
  });

  it("a sync token Google no longer accepts (410): starts over without one", async () => {
    state.pages = [new GoogleError("sync_token_gone", 410), [{ id: "ev1", status: "cancelled" }]];
    await sync();
    expect(state.calls.filter((c) => c[0] === "list")).toEqual([
      ["list", "host@example.com", "old"],
      ["list", "host@example.com", null],
    ]);
    expect(actions().map((c) => c[0])).toEqual(["calendar_booking_deleted", "cancelMails"]);
    expect(release()[0]).toMatchObject({ p_save_token: true });
  });

  it("another error: failed, the token kept", async () => {
    state.pages = [new GoogleError("UNAVAILABLE", 503)];
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sync()).toBe("failed");
    expect(release()).toEqual([{ p_user_id: user, p_sync_token: null, p_save_token: false }]);
  });

  it("busy when another sync runs; goes again when a notification came in meanwhile", async () => {
    state.claims = [];
    expect(await sync()).toBe("busy");
    state.claims = [
      { sync_token: "old", primary_calendar_id: "host@example.com" },
      { sync_token: "next-1", primary_calendar_id: "host@example.com" },
    ];
    state.again = [true, false];
    state.calls = [];
    expect(await sync()).toBe("synced");
    expect(state.calls.filter((c) => c[0] === "list")).toHaveLength(2);
  });
});
