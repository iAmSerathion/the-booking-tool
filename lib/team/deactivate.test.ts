import { beforeEach, describe, expect, it, vi } from "vitest";

// The hand-over with the database and Google stubbed: checks before Google, the order (leases, new events,
// deactivate_profile, old events, disconnect), fresh event ids, and the cleanup when Google or the RPC fails.
// deactivate_profile itself is tested against Postgres in tests/db/team.test.ts.

const person = "00000000-0000-4000-8000-0000000000a1";
const to = "00000000-0000-4000-8000-0000000000b2";
const actor = "00000000-0000-4000-8000-0000000000c3";
const booking = (n: number) => ({
  id: `00000000-0000-4000-8000-00000000010${n}`,
  starts_at: "2030-01-0" + n + "T09:00:00Z",
  ends_at: "2030-01-0" + n + "T09:30:00Z",
  invitee_name: `Guest ${n}`,
  invitee_email: `guest${n}@example.com`,
  google_event_id: `old${n}`,
  meet_url: null,
  event_types: { title: "Meeting" },
});

const state = vi.hoisted(() => ({
  people: [] as Record<string, unknown>[],
  bookings: [] as Record<string, unknown>[],
  calendar: "succ@example.com" as string | null,
  accessOk: true,
  leaseFailAt: -1,
  failInsertAt: -1,
  rpcError: null as { code: string; message: string } | null,
  // What a read after the leases returns (a reschedule committed in between); null: the same as before.
  bookingsUnderLease: null as Record<string, unknown>[] | null,
  activeAfter: true as boolean | null,
  calls: [] as unknown[][],
}));

vi.mock("next/cache", () => ({ updateTag: (tag: string) => state.calls.push(["updateTag", tag]) }));
vi.mock("@/lib/availability/data", () => ({ busyCacheTag: (id: string) => `busy-${id}` }));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ appUrl: "https://booking.example.com", locale: "en" }) }));
vi.mock("@/lib/booking/lease", () => ({
  takeLease: async (id: string) => (state.calls.push(["takeLease", id]) - 1 !== state.leaseFailAt ? `until-${id}` : null),
  dropLease: async (id: string, until: string) => state.calls.push(["dropLease", id, until]),
}));
vi.mock("@/lib/booking/google", () => ({
  removeBookingEvent: async (...args: unknown[]) => (state.calls.push(["removeBookingEvent", ...args]), true),
  removeBookingEventsFrom: async (id: string) => (state.calls.push(["removeBookingEventsFrom", id]), true),
}));
vi.mock("@/lib/google/connection", () => ({
  googleAccess: async () => (state.accessOk ? { ok: true, token: "succ-token" } : { ok: false, reason: "not_connected" }),
  disconnectGoogle: async (id: string) => (state.calls.push(["disconnectGoogle", id]), true),
}));
vi.mock("@/lib/google/calendar", () => ({
  googleEventId: (id: string) => id.replace(/-/g, ""),
  createEvent: async (_token: string, calendar: string, event: { eventId: string; meet: boolean; description: string }) => {
    const n = state.calls.filter((c) => c[0] === "createEvent").length;
    state.calls.push(["createEvent", calendar, event]);
    if (n === state.failInsertAt) throw new Error("Google down");
    return { id: event.eventId, meetUrl: event.meet ? `https://meet.google.com/${event.eventId}` : null };
  },
  deleteEvent: async (...args: unknown[]) => state.calls.push(["deleteEvent", ...args]),
}));
vi.mock("@/lib/db/admin", () => ({
  createAdminSupabase: () => ({
    rpc: async (name: string, args: unknown) => (state.calls.push([name, args]), { data: null, error: state.rpcError }),
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        then: (resolve: (r: unknown) => unknown) =>
          resolve({
            data: table === "profiles" ? state.people : state.bookingsUnderLease && names().includes("takeLease") ? state.bookingsUnderLease : state.bookings,
            error: null,
          }),
        single: async () =>
          state.activeAfter === null ? { data: null, error: { code: "", message: "fetch failed" } } : { data: { active: state.activeAfter }, error: null },
        maybeSingle: async () => ({ data: table === "calendar_connections" && state.calendar ? { primary_calendar_id: state.calendar } : null, error: null }),
        insert: async (row: unknown) => (state.calls.push([`${table}.insert`, row]), { error: null }),
        delete: () => ({ in: async (_c: string, values: unknown[]) => (state.calls.push([`${table}.delete`, values.length]), { error: null }) }),
      };
      for (const method of ["select", "eq", "gt", "in"]) chain[method] = () => chain;
      return chain;
    },
  }),
}));

const { deactivate } = await import("./deactivate");
const run = () => deactivate({ actorId: actor, personId: person, toId: to });
const names = () => state.calls.map((c) => c[0]);

beforeEach(() => {
  Object.assign(state, {
    people: [
      { id: person, name: "Ada", active: true, bookable: true, timezone: "Europe/Berlin", meet_auto: true },
      { id: to, name: "Bo", active: true, bookable: true, timezone: "Europe/Berlin", meet_auto: false },
    ],
    bookings: [booking(1), booking(2)],
    calendar: "succ@example.com",
    accessOk: true,
    leaseFailAt: -1,
    failInsertAt: -1,
    rpcError: null,
    bookingsUnderLease: null,
    activeAfter: true,
    calls: [],
  });
});

describe("deactivate", () => {
  it("creates the new events, then deactivates with the plan, then removes the old events and the connection", async () => {
    state.bookings[1] = { ...booking(2), meet_url: "https://meet.google.com/old" };
    expect(await run()).toEqual({ ok: true, message: "Ada is deactivated. 2 upcoming bookings moved to Bo." });
    expect(names().filter((n) => !String(n).endsWith(".insert"))).toEqual([
      "takeLease",
      "takeLease",
      "createEvent",
      "createEvent",
      "deactivate_profile",
      "dropLease",
      "dropLease",
      "removeBookingEvent",
      "removeBookingEvent",
      "removeBookingEventsFrom",
      "disconnectGoogle",
      "updateTag",
      "updateTag",
    ]);
    const events = state.calls.filter((c) => c[0] === "createEvent").map((c) => c[2] as { eventId: string; meet: boolean; summary: string; description: string });
    // A fresh id per event, never the booking's own; Meet only where the booking had it (Bo has meet_auto off).
    expect(events[0].eventId).toMatch(new RegExp(`^${booking(1).id.replace(/-/g, "")}[0-9a-f]{8}$`));
    expect(events.map((e) => e.meet)).toEqual([false, true]);
    expect(events[0].summary).toContain("Bo");
    expect(events[0].description).toContain("https://booking.example.com/confirmed/");
    const rpc = state.calls.find((c) => c[0] === "deactivate_profile")![1] as { p_actor_id: string; p_plan: { bookings: { id: string; google_event_id: string }[] } };
    expect(rpc.p_actor_id).toBe(actor);
    expect(rpc.p_plan.bookings.map((b) => [b.id, b.google_event_id])).toEqual([
      [booking(1).id, events[0].eventId],
      [booking(2).id, events[1].eventId],
    ]);
    expect(state.calls.filter((c) => c[0] === "removeBookingEvent")).toEqual([
      ["removeBookingEvent", person, "old1"],
      ["removeBookingEvent", person, "old2"],
    ]);
  });

  it("deletes every created event, the lost one included, when Google fails in the middle", async () => {
    state.failInsertAt = 1;
    expect(await run()).toEqual({ ok: false, error: "Google did not accept the new events. Nothing was changed." });
    const ids = state.calls.filter((c) => c[0] === "createEvent").map((c) => (c[2] as { eventId: string }).eventId);
    expect(state.calls.filter((c) => c[0] === "deleteEvent")).toEqual(ids.map((id) => ["deleteEvent", "succ-token", "succ@example.com", id, "all"]));
    expect(state.calls).toContainEqual(["booking_tokens.delete", 2]);
    expect(names()).not.toContain("deactivate_profile");
    expect(names()).not.toContain("removeBookingEvent");
    expect(names().filter((n) => n === "dropLease")).toHaveLength(2);
  });

  it("deletes the new events and shows the database's refusal when the RPC fails", async () => {
    state.rpcError = { code: "P0002", message: "Bookings changed in the meantime. Please try again." };
    expect(await run()).toEqual({ ok: false, error: "Bookings changed in the meantime. Please try again." });
    expect(names().filter((n) => n === "deleteEvent")).toHaveLength(2);
    expect(names()).not.toContain("removeBookingEvent");
    expect(names()).not.toContain("disconnectGoogle");
  });

  it("refuses before Google when the successor cannot take the bookings", async () => {
    state.calendar = null;
    expect(await run()).toEqual({ ok: false, error: "Bo must connect Google Calendar first." });
    state.people[1] = { ...state.people[1], bookable: false };
    expect(await run()).toEqual({ ok: false, error: "The member who takes over must be bookable." });
    state.people[1] = { ...state.people[1], active: false };
    expect(await run()).toEqual({ ok: false, error: "Please pick an active member to take over." });
    expect(await deactivate({ actorId: actor, personId: actor, toId: to })).toEqual({ ok: false, error: "You cannot deactivate yourself." });
    expect(names()).toEqual([]);
  });

  it("refuses while a booking is being changed and gives back the leases it took", async () => {
    state.leaseFailAt = 1;
    expect(await run()).toEqual({ ok: false, error: "A booking is being changed right now. Please try again." });
    expect(state.calls).toEqual([
      ["takeLease", booking(1).id],
      ["takeLease", booking(2).id],
      ["dropLease", booking(1).id, `until-${booking(1).id}`],
    ]);
  });

  it("hands over without bookings, even to a member who is not bookable (the database checks widgets and website)", async () => {
    state.bookings = [];
    state.people[1] = { ...state.people[1], bookable: false };
    expect(await run()).toMatchObject({ ok: true, message: "Ada is deactivated. 0 upcoming bookings moved to Bo." });
    expect(state.calls).toContainEqual(["deactivate_profile", { p_person_id: person, p_to_id: to, p_actor_id: actor, p_plan: { bookings: [] } }]);
  });
  it("builds the new events from the bookings as they are under the leases, and sends their times in the plan", async () => {
    const moved = { ...booking(1), starts_at: "2030-01-05T14:00:00Z", ends_at: "2030-01-05T14:30:00Z" };
    state.bookingsUnderLease = [moved, booking(2)];
    expect(await run()).toMatchObject({ ok: true });
    const first = state.calls.find((c) => c[0] === "createEvent")![2] as { start: Date; end: Date };
    expect([first.start.toISOString(), first.end.toISOString()]).toEqual(["2030-01-05T14:00:00.000Z", "2030-01-05T14:30:00.000Z"]);
    const rpc = state.calls.find((c) => c[0] === "deactivate_profile")![1] as { p_plan: { bookings: { starts_at: string; ends_at: string }[] } };
    expect(rpc.p_plan.bookings[0]).toMatchObject({ starts_at: moved.starts_at, ends_at: moved.ends_at });
  });

  it("refuses before Google when a booking left the member before the leases were taken", async () => {
    state.bookingsUnderLease = [booking(2)];
    expect(await run()).toEqual({ ok: false, error: "Bookings changed in the meantime. Please try again." });
    expect(names()).not.toContain("createEvent");
    expect(names().filter((n) => n === "dropLease")).toHaveLength(2);
  });

  it("sends meet_url null when Meet was asked for but Google gave no link yet", async () => {
    state.bookings = [{ ...booking(1), meet_url: "https://meet.google.com/old" }];
    state.people[1] = { ...state.people[1], meet_auto: true };
    const calendar = await import("@/lib/google/calendar");
    vi.spyOn(calendar, "createEvent").mockResolvedValueOnce({ id: "pending-meet", meetUrl: null });
    expect(await run()).toMatchObject({ ok: true });
    const rpc = state.calls.find((c) => c[0] === "deactivate_profile")![1] as { p_plan: { bookings: { meet_url: string | null }[] } };
    expect(rpc.p_plan.bookings).toEqual([expect.objectContaining({ google_event_id: "pending-meet", meet_url: null })]);
  });

  it("finishes the hand-over when the RPC answer is lost but the member reads back as inactive", async () => {
    state.rpcError = { code: "", message: "TypeError: fetch failed" };
    state.activeAfter = false;
    expect(await run()).toEqual({ ok: true, message: "Ada is deactivated. 2 upcoming bookings moved to Bo." });
    expect(names()).not.toContain("deleteEvent");
    expect(names()).not.toContain("booking_tokens.delete");
    expect(names().filter((n) => n === "removeBookingEvent")).toHaveLength(2);
    expect(names()).toContain("disconnectGoogle");
  });

  it("cleans up when the RPC answer is lost and the member is still active", async () => {
    state.rpcError = { code: "", message: "TypeError: fetch failed" };
    expect(await run()).toEqual({ ok: false, error: "Deactivating failed. Please try again." });
    expect(names().filter((n) => n === "deleteEvent")).toHaveLength(2);
    expect(names()).not.toContain("disconnectGoogle");
  });

  it("leaves the new events alone when neither the RPC answer nor the member can be read", async () => {
    state.rpcError = { code: "", message: "TypeError: fetch failed" };
    state.activeAfter = null;
    expect(await run()).toEqual({ ok: false, error: "The answer from the database got lost. Please check the team page before you try again." });
    expect(names()).not.toContain("deleteEvent");
    expect(names()).not.toContain("disconnectGoogle");
  });

  it("sweeps the member's calendar for other booking events before the Google grant is revoked", async () => {
    state.bookings = [];
    expect(await run()).toMatchObject({ ok: true });
    expect(names().slice(-4, -2)).toEqual(["removeBookingEventsFrom", "disconnectGoogle"]);
  });
});
