import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleError } from "./oauth";
import { createEvent, deleteEvent, freeBusy, listEvents } from "./calendar";

const env = {
  APP_URL: "https://booking.example.com",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54421",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  GOOGLE_CLIENT_ID: "client",
  GOOGLE_CLIENT_SECRET: "secret",
  SCHEDULER_SECRET: "x".repeat(32),
  SMTP_URL: "smtp://127.0.0.1:2525",
  MAIL_FROM: "bookings@example.com",
  GOOGLE_FAKE_URL: "",
};

type Call = { url: string; init?: RequestInit };
let calls: Call[];

// Answers each request with the next queued response.
function stubFetch(...responses: { status?: number; body: unknown }[]) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const next = responses.shift() ?? { body: {} };
      return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
    }),
  );
}

beforeEach(() => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const from = new Date("2026-11-02T00:00:00Z");
const to = new Date("2026-11-03T00:00:00Z");
const block = { start: "2026-11-02T09:00:00Z", end: "2026-11-02T10:00:00Z" };

describe("freeBusy", () => {
  it("returns the busy blocks of every readable calendar and skips unreadable extra calendars", async () => {
    stubFetch({ body: { calendars: { "host@example.com": { busy: [block] }, "team@example.com": { errors: [{ reason: "notFound" }] } } } });
    expect(await freeBusy("token", ["host@example.com", "team@example.com"], from, to, "host@example.com")).toEqual([block]);
    expect(calls[0].url).toBe("https://www.googleapis.com/calendar/v3/freeBusy");
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe("Bearer token");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      items: [{ id: "host@example.com" }, { id: "team@example.com" }],
    });
  });

  it("throws when the primary calendar cannot be read, so the host never looks free", async () => {
    stubFetch({ body: { calendars: { "host@example.com": { errors: [{ reason: "notFound" }] } } } });
    await expect(freeBusy("token", ["host@example.com"], from, to, "host@example.com")).rejects.toMatchObject({ code: "free_busy_primary" });
    stubFetch({ body: { calendars: {} } });
    await expect(freeBusy("token", ["host@example.com"], from, to, "host@example.com")).rejects.toBeInstanceOf(GoogleError);
  });

  it("asks for at most 50 calendars per request", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `c${i}@example.com`);
    stubFetch({ body: { calendars: Object.fromEntries(ids.slice(0, 50).map((id) => [id, { busy: [block] }])) } }, { body: { calendars: { [ids[50]]: { busy: [] } } } });
    expect(await freeBusy("token", ids, from, to, ids[0])).toHaveLength(50);
    expect(calls.map((call) => JSON.parse(String(call.init?.body)).items.length)).toEqual([50, 1]);
  });

  it("throws on an HTTP error with Google's status", async () => {
    stubFetch({ status: 401, body: { error: { status: "UNAUTHENTICATED" } } });
    await expect(freeBusy("token", ["host@example.com"], from, to, "host@example.com")).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
  });
});

describe("listEvents", () => {
  it("reads every page of single events for an encoded calendar id", async () => {
    const holiday = { status: "confirmed", start: { date: "2026-11-02" }, end: { date: "2026-11-03" }, description: "Public holiday" };
    stubFetch({ body: { items: [holiday], nextPageToken: "p2" } }, { body: { items: [{ ...holiday, status: "cancelled" }] } });
    const id = "en.usa#holiday@group.v.calendar.google.com";
    expect(await listEvents("token", id, from, to)).toHaveLength(2);
    const [first, second] = calls.map((call) => new URL(call.url));
    expect(first.pathname).toBe("/calendar/v3/calendars/en.usa%23holiday%40group.v.calendar.google.com/events");
    expect(first.searchParams.get("singleEvents")).toBe("true");
    expect(first.searchParams.get("timeMin")).toBe(from.toISOString());
    expect(first.searchParams.has("pageToken")).toBe(false);
    expect(second.searchParams.get("pageToken")).toBe("p2");
  });

  it("throws on an HTTP error", async () => {
    stubFetch({ status: 404, body: { error: { status: "NOT_FOUND" } } });
    await expect(listEvents("token", "gone@example.com", from, to)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("createEvent", () => {
  const event = {
    bookingId: "b1",
    summary: "Meeting: Ada and Host",
    description: "Details",
    start: new Date("2026-11-04T09:30:00Z"),
    end: new Date("2026-11-04T10:00:00Z"),
    timeZone: "Europe/Berlin",
    attendees: [{ email: "ada@example.com", displayName: "Ada" }],
  };

  it("asks for a Meet conference and invites the guest", async () => {
    stubFetch({ body: { id: "e1", hangoutLink: "https://meet.google.com/abc-defg-hij" } });
    expect(await createEvent("token", "host#1@example.com", { ...event, meet: true })).toEqual({ id: "e1", meetUrl: "https://meet.google.com/abc-defg-hij" });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/calendar/v3/calendars/host%231%40example.com/events");
    expect(Object.fromEntries(url.searchParams)).toEqual({ sendUpdates: "all", conferenceDataVersion: "1" });
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      start: { dateTime: "2026-11-04T09:30:00.000Z", timeZone: "Europe/Berlin" },
      attendees: event.attendees,
      extendedProperties: { private: { booking_id: "b1" } },
      conferenceData: { createRequest: { requestId: "b1", conferenceSolutionKey: { type: "hangoutsMeet" } } },
    });
  });

  it("takes the Meet link from the video entry point, and none without meet", async () => {
    stubFetch({ body: { id: "e1", conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:1" }, { entryPointType: "video", uri: "https://meet.google.com/x" }] } } });
    expect((await createEvent("token", "host@example.com", { ...event, meet: true })).meetUrl).toBe("https://meet.google.com/x");
    stubFetch({ body: { id: "e2" } });
    expect(await createEvent("token", "host@example.com", { ...event, meet: false })).toEqual({ id: "e2", meetUrl: null });
    expect(JSON.parse(String(calls[0].init?.body))).not.toHaveProperty("conferenceData");
  });

  it("throws when Google refuses or returns no id", async () => {
    stubFetch({ status: 403, body: { error: { status: "PERMISSION_DENIED" } } });
    await expect(createEvent("token", "host@example.com", { ...event, meet: false })).rejects.toMatchObject({ code: "PERMISSION_DENIED", status: 403 });
    stubFetch({ body: {} });
    await expect(createEvent("token", "host@example.com", { ...event, meet: false })).rejects.toMatchObject({ code: "event_insert" });
  });
});

describe("deleteEvent", () => {
  it("deletes with the given sendUpdates and treats a gone event as done", async () => {
    stubFetch({ body: {} });
    await deleteEvent("token", "host@example.com", "e/1", "none");
    expect(calls[0].init?.method).toBe("DELETE");
    expect(calls[0].url).toBe("https://www.googleapis.com/calendar/v3/calendars/host%40example.com/events/e%2F1?sendUpdates=none");
    stubFetch({ status: 410, body: {} });
    await deleteEvent("token", "host@example.com", "e1");
    expect(new URL(calls[0].url).searchParams.get("sendUpdates")).toBe("all");
  });

  it("throws on other errors", async () => {
    stubFetch({ status: 500, body: {} });
    await expect(deleteEvent("token", "host@example.com", "e1")).rejects.toMatchObject({ code: "event_delete", status: 500 });
  });
});
