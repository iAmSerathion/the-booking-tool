import { describe, expect, it } from "vitest";
import { calendarChange, channelDue, matchBooking, syncDue, webhookAddress, type GoogleEvent, type SyncBooking } from "./calendar-sync";

const now = new Date("2030-01-02T08:00:00Z");
const start = new Date("2030-01-04T09:30:00Z");
const end = new Date("2030-01-04T10:15:00Z");
const host = "host@example.com";
const invitee = "sam@example.com";

const booking = (patch: Partial<SyncBooking> = {}): SyncBooking => ({
  state: "booked",
  startsAt: start,
  endsAt: end,
  inviteeEmail: invitee,
  responses: { [invitee]: "needsAction", [host]: "accepted" },
  changingUntil: null,
  ...patch,
});

const event = (patch: Partial<GoogleEvent> = {}): GoogleEvent => ({
  id: "ev1",
  status: "confirmed",
  start: { dateTime: start.toISOString() },
  end: { dateTime: end.toISOString() },
  attendees: [
    { email: invitee, responseStatus: "needsAction" },
    { email: "Host@Example.com", responseStatus: "accepted", self: true, organizer: true },
  ],
  ...patch,
});

const attendees = (responses: Record<string, string>) => Object.entries(responses).map(([email, responseStatus]) => ({ email, responseStatus }));
const deleted: GoogleEvent = { id: "ev1", status: "cancelled" };

describe("calendarChange", () => {
  it("nothing changed: nothing to do", () => {
    expect(calendarChange(booking(), event(), now)).toEqual({ defer: false, change: null, responses: null });
  });

  it("moved: the new time, in any offset notation", () => {
    const decision = calendarChange(booking(), event({ start: { dateTime: "2030-01-05T13:30:00+01:00" }, end: { dateTime: "2030-01-05T14:15:00+01:00" } }), now);
    expect(decision).toEqual({
      defer: false,
      change: { type: "moved", startsAt: new Date("2030-01-05T12:30:00Z"), endsAt: new Date("2030-01-05T13:15:00Z") },
      responses: null,
    });
  });

  it("only the end changed: also moved", () => {
    const decision = calendarChange(booking(), event({ end: { dateTime: "2030-01-04T10:30:00Z" } }), now);
    expect(decision).toMatchObject({ change: { type: "moved", startsAt: start, endsAt: new Date("2030-01-04T10:30:00Z") } });
  });

  it("made all-day: no time, not moved", () => {
    expect(calendarChange(booking(), event({ start: { date: "2030-01-04" }, end: { date: "2030-01-05" } }), now)).toMatchObject({ change: null });
  });

  it("deleted in the host's calendar: cancelled by the host", () => {
    expect(calendarChange(booking(), deleted, now)).toEqual({ defer: false, change: { type: "deleted" }, responses: null });
  });

  it("the invitee declined: cancelled by the invitee, and that wins over a move", () => {
    const responses = { [invitee]: "declined", [host]: "accepted" };
    const decision = calendarChange(booking(), event({ attendees: attendees(responses), start: { dateTime: "2030-01-05T09:30:00Z" } }), now);
    expect(decision).toEqual({ defer: false, change: { type: "declined", email: invitee }, responses });
  });

  it("the invitee's decline matches regardless of case and a +tag", () => {
    expect(calendarChange(booking({ inviteeEmail: "Sam@Example.com" }), event({ attendees: [{ email: "SAM@example.com", responseStatus: "declined" }] }), now)).toMatchObject({
      change: { type: "declined" },
    });
    const tagged = booking({ inviteeEmail: "sam+test@example.com", responses: { "sam+test@example.com": "needsAction" } });
    const decision = calendarChange(tagged, event({ attendees: [{ email: "sam+test@example.com", responseStatus: "needsAction" }, { email: "sam@example.com", responseStatus: "declined" }] }), now);
    expect(decision).toMatchObject({ change: { type: "declined", email: "sam@example.com" } });
  });

  it("a decline counts once: reported again, nothing happens", () => {
    const responses = { [invitee]: "declined", [host]: "accepted" };
    expect(calendarChange(booking({ responses }), event({ attendees: attendees(responses) }), now)).toEqual({ defer: false, change: null, responses: null });
  });

  it("another guest's decline and other responses are only stored", () => {
    const responses = { [invitee]: "accepted", "guest@example.com": "declined" };
    expect(calendarChange(booking(), event({ attendees: attendees(responses) }), now)).toEqual({ defer: false, change: null, responses });
  });

  it("the host's own decline is not a cancel", () => {
    const responses = { [invitee]: "needsAction", [host]: "declined" };
    expect(calendarChange(booking(), event({ attendees: attendees(responses) }), now)).toEqual({ defer: false, change: null, responses });
  });

  it("past: deleting and declining change nothing, a move into the future does", () => {
    const past = booking({ startsAt: new Date("2030-01-01T09:00:00Z"), endsAt: new Date("2030-01-01T09:45:00Z") });
    expect(calendarChange(past, deleted, now)).toMatchObject({ change: null });
    const stillPast = { start: { dateTime: "2030-01-01T09:00:00Z" }, end: { dateTime: "2030-01-01T09:45:00Z" } };
    expect(calendarChange(past, event({ ...stillPast, attendees: [{ email: invitee, responseStatus: "declined" }] }), now)).toMatchObject({ change: null });
    expect(calendarChange(past, event({ start: { dateTime: "2030-01-01T10:00:00Z" }, end: { dateTime: "2030-01-01T10:45:00Z" } }), now)).toMatchObject({ change: null });
    expect(calendarChange(past, event(), now)).toMatchObject({ change: { type: "moved", startsAt: start } });
    // Moved into the future and declined: only moved, a cancel is only possible before the start.
    expect(calendarChange(past, event({ attendees: [{ email: invitee, responseStatus: "declined" }] }), now)).toMatchObject({ change: { type: "moved" } });
  });

  it("a cancelled booking: nothing", () => {
    expect(calendarChange(booking({ state: "cancelled" }), deleted, now)).toEqual({ defer: false, change: null, responses: null });
    expect(calendarChange(booking({ state: "cancelled" }), event({ start: { dateTime: "2030-01-05T09:30:00Z" } }), now)).toMatchObject({ change: null });
  });

  it("deferred while the tool changes the event itself, before any other check; not once the lease ends", () => {
    const changing = { changingUntil: new Date(now.getTime() + 60_000) };
    expect(calendarChange(booking(changing), deleted, now)).toEqual({ defer: true });
    expect(calendarChange(booking({ ...changing, state: "cancelled" }), event(), now)).toEqual({ defer: true });
    expect(calendarChange(booking({ changingUntil: now }), deleted, now)).toMatchObject({ defer: false, change: { type: "deleted" } });
    expect(calendarChange(booking({ changingUntil: new Date(now.getTime() - 1) }), event(), now)).toMatchObject({ defer: false });
  });
});

describe("matchBooking", () => {
  const userId = "u1";
  const row = (patch: Partial<{ id: string; host_id: string; google_event_id: string | null; state: string }>) => ({ id: "b1", host_id: userId, google_event_id: "ev1", state: "booked", ...patch });

  it("finds the host's own booking by its event id", () => {
    expect(matchBooking(event(), [row({})], userId)).toMatchObject({ id: "b1" });
  });

  it("prefers the booked one when a cancelled booking had the same event id", () => {
    expect(matchBooking(event(), [row({ id: "old", state: "cancelled" }), row({ id: "new" })], userId)).toMatchObject({ id: "new" });
  });

  it("skips an event the database does not know, also one with a booking id from another install", () => {
    expect(matchBooking(event({ id: "foreign" }), [row({})], userId)).toBeNull();
    expect(matchBooking(event({ id: "other-install", extendedProperties: { private: { booking_id: "b1" } } }), [row({})], userId)).toBeNull();
  });

  it("skips the same event id on another host's booking", () => {
    expect(matchBooking(event(), [row({ host_id: "u2" })], userId)).toBeNull();
  });
});

describe("push channel and safety sync", () => {
  const hours = (n: number) => new Date(now.getTime() + n * 3_600_000);

  it("renews when there is none, when it is a day old or expires within a day", () => {
    expect(channelDue({ channelId: null, renewedAt: null, expiresAt: null, now })).toBe(true);
    expect(channelDue({ channelId: "c1", renewedAt: hours(-23), expiresAt: hours(24 * 6), now })).toBe(false);
    expect(channelDue({ channelId: "c1", renewedAt: hours(-24), expiresAt: hours(24 * 6), now })).toBe(true);
    expect(channelDue({ channelId: "c1", renewedAt: hours(-1), expiresAt: hours(23), now })).toBe(true);
  });

  it("after Google refused a channel, retries at most once an hour", () => {
    expect(channelDue({ channelId: null, renewedAt: new Date(now.getTime() - 59 * 60_000), expiresAt: null, now })).toBe(false);
    expect(channelDue({ channelId: null, renewedAt: hours(-1), expiresAt: null, now })).toBe(true);
  });

  it("after a failed renewal of an expiring or expired channel, retries at most once an hour", () => {
    const minutes = (m: number) => new Date(now.getTime() + m * 60_000);
    expect(channelDue({ channelId: "c1", renewedAt: minutes(-1), expiresAt: hours(2), now })).toBe(false);
    expect(channelDue({ channelId: "c1", renewedAt: minutes(-1), expiresAt: hours(-2), now })).toBe(false);
    expect(channelDue({ channelId: "c1", renewedAt: minutes(-61), expiresAt: hours(2), now })).toBe(true);
    expect(channelDue({ channelId: "c1", renewedAt: minutes(-61), expiresAt: hours(-2), now })).toBe(true);
  });

  it("syncs every 15 minutes", () => {
    expect(syncDue(null, now)).toBe(true);
    expect(syncDue(new Date(now.getTime() - 14 * 60_000), now)).toBe(false);
    expect(syncDue(new Date(now.getTime() - 15 * 60_000), now)).toBe(true);
  });

  it("notifies only https, or any address with the loopback fake", () => {
    expect(webhookAddress("https://booking.example.com/", false)).toBe("https://booking.example.com/api/google/calendar-webhook");
    expect(webhookAddress("http://127.0.0.1:3000", false)).toBeNull();
    expect(webhookAddress("http://127.0.0.1:3000", true)).toBe("http://127.0.0.1:3000/api/google/calendar-webhook");
  });
});
