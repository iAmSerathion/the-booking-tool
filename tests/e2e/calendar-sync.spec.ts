import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { bookingsOf, fakeEvents, fillDetails, newHost, nextDay, openDay, removeHost, zone } from "./booking-helpers";
import { googleFakeUrl } from "./env";
import { mailsTo, waitForMails } from "./mail-helpers";
import { admin } from "./session";

// Calendar sync end to end: the scheduler's upkeep creates the push channel and runs the first sync; then changes made
// in the fake (as the host or a guest would in Google) reach the app through the webhook. Each test has its own host and
// calendar, and every scheduler call is scoped to that host (x-test-user), so parallel tests never sync each other.

test.use({ timezoneId: zone, locale: "en-US" });

const hour = 3_600_000;
type Host = Awaited<ReturnType<typeof newHost>>;

async function book(page: Page, slug: string, invitee: string) {
  await page.goto(`/${slug}`);
  await (await openDay(page, nextDay([1, 2, 3, 4, 5]))).getByRole("button", { name: "9:00 AM" }).click();
  await fillDetails(page, "Sam Invitee", invitee);
  await page.getByRole("button", { name: "Book this time" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your booking is confirmed.");
}

const upkeep = (baseURL: string, userId: string, now = Date.now()) =>
  fetch(`${baseURL}/api/jobs/scheduler`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.SCHEDULER_SECRET}`, "x-test-now": new Date(now).toISOString(), "x-test-user": userId },
  });

const channels = async (calendar: string) =>
  (await fetch(`${googleFakeUrl}/control/channels?calendar=${encodeURIComponent(calendar)}`).then((r) => r.json())).items as { id: string; token: string }[];
const control = (calendar: string, action: string, event: string, body: unknown = {}) =>
  fetch(`${googleFakeUrl}/control/calendar?${new URLSearchParams({ calendar, action, event })}`, { method: "POST", body: JSON.stringify(body) });
const syncState = async (userId: string) =>
  (await admin().from("calendar_connections").select("sync_token, synced_at").eq("user_id", userId).single()).data!;
const bookingOf = async (id: string) =>
  (await admin().from("bookings").select("state, cancelled_by, starts_at, ends_at, reschedule_count, google_change_until").eq("id", id).single()).data!;
const outbox = async (id: string) => (await admin().from("booking_outbox").select("type, payload").eq("booking_id", id).order("created_at")).data!;

// A host with a booking and a live channel, after the first sync stored a token.
async function setUp(page: Page, baseURL: string) {
  const host = await newHost({ name: "Avery Host" });
  const invitee = `invitee-${randomUUID()}@example.com`;
  await book(page, host.slug, invitee);
  const [booking] = await bookingsOf(host.id);
  expect(booking.google_event_id).toBeTruthy();
  const response = await upkeep(baseURL, host.id);
  expect((await response.json()).calendar).toEqual({ renewed: 1, synced: 1, failed: 0 });
  expect(await channels(host.email)).toHaveLength(1);
  expect((await syncState(host.id)).sync_token).toMatch(/^seq:/);
  return { host, invitee, booking, eventId: booking.google_event_id! };
}

// The webhook syncs in after(): wait until a sync after `since` has finished.
async function syncedAfter(userId: string, since: string | null) {
  await expect.poll(async () => (await syncState(userId)).synced_at !== since, { timeout: 15_000 }).toBe(true);
}

let host: Host | null = null;
test.afterEach(async () => {
  if (host) await removeHost(host.id);
  host = null;
});

test("moving the event in the calendar moves the booking, re-plans the reminders and tells the invitee", async ({ page, baseURL }) => {
  const s = await setUp(page, baseURL!);
  host = s.host;
  const start = Date.parse(s.booking.starts_at);
  const moved = { start: new Date(start + 2 * hour).toISOString(), end: new Date(Date.parse(s.booking.ends_at) + 2 * hour).toISOString() };
  await control(s.host.email, "move", s.eventId, moved);

  await expect.poll(async () => Date.parse((await bookingOf(s.booking.id)).starts_at), { timeout: 15_000 }).toBe(Date.parse(moved.start));
  expect(await bookingOf(s.booking.id)).toMatchObject({ state: "booked", reschedule_count: 0 });
  expect(Date.parse((await bookingOf(s.booking.id)).ends_at)).toBe(Date.parse(moved.end));
  await expect
    .poll(async () => (await admin().from("booking_jobs").select("planned_for").eq("booking_id", s.booking.id).eq("state", "planned")).data!.map((j) => Date.parse(j.planned_for)))
    .toEqual([Date.parse(moved.start), Date.parse(moved.start)]);
  const changes = (await outbox(s.booking.id)).filter((row) => row.type === "booking.rescheduled");
  expect(changes).toHaveLength(1);
  expect(changes[0].payload).toMatchObject({ changed_by: "calendar" });

  const notice = (await waitForMails(s.invitee, 2)).find((m) => m.subject === "New time: Meeting with Avery Host")!;
  expect(notice.text).toContain("Avery Host moved your booking to a new time.");
  expect(notice.text).toContain(`${baseURL}/reschedule/`);
  expect(notice.replyTo).toBe(s.host.email);
});

test("the invitee declining the invitation cancels the booking, removes the event and tells both sides", async ({ page, baseURL }) => {
  const s = await setUp(page, baseURL!);
  host = s.host;
  await control(s.host.email, "respond", s.eventId, { email: s.invitee, responseStatus: "declined" });

  await expect.poll(async () => (await bookingOf(s.booking.id)).state, { timeout: 15_000 }).toBe("cancelled");
  expect((await bookingOf(s.booking.id)).cancelled_by).toBe("invitee");
  await expect.poll(async () => (await fakeEvents(s.host.email)).find((e) => e.id === s.eventId)?.status).toBe("cancelled");
  expect((await outbox(s.booking.id)).map((row) => row.type)).toContain("booking.cancelled");

  const mail = (await waitForMails(s.invitee, 2)).find((m) => m.subject === "Cancelled: Meeting with Avery Host")!;
  expect(mail.text).toContain("your booking is cancelled.");
  expect(mail.text).toContain(`${baseURL}/cancel/`);
  await expect.poll(async () => (await mailsTo(s.host.email)).filter((m) => m.subject.startsWith("Cancelled: Sam Invitee")).length).toBe(1);
});

test("the host deleting the event cancels the booking as the host; only the invitee is told", async ({ page, baseURL }) => {
  const s = await setUp(page, baseURL!);
  host = s.host;
  await control(s.host.email, "delete", s.eventId);

  await expect.poll(async () => (await bookingOf(s.booking.id)).state, { timeout: 15_000 }).toBe("cancelled");
  expect((await bookingOf(s.booking.id)).cancelled_by).toBe("host");
  const mail = (await waitForMails(s.invitee, 2)).find((m) => m.subject === "Cancelled: Meeting with Avery Host")!;
  expect(mail.text).toContain("Avery Host cancelled your booking.");
  expect((await mailsTo(s.host.email)).filter((m) => m.subject.startsWith("Cancelled:"))).toEqual([]);
});

test("a change during the invitee's reschedule lease is deferred with the old token, and applies once the lease is gone", async ({ page, baseURL }) => {
  const s = await setUp(page, baseURL!);
  host = s.host;
  const lease = new Date(Date.now() + 120_000).toISOString();
  await admin().from("bookings").update({ google_change_until: lease }).eq("id", s.booking.id);
  const before = await syncState(s.host.id);
  const moved = { start: new Date(Date.parse(s.booking.starts_at) + hour).toISOString(), end: new Date(Date.parse(s.booking.ends_at) + hour).toISOString() };
  await control(s.host.email, "move", s.eventId, moved);

  // The notification's sync ran, but left the booking and the token alone.
  await syncedAfter(s.host.id, before.synced_at);
  expect((await syncState(s.host.id)).sync_token).toBe(before.sync_token);
  expect(Date.parse((await bookingOf(s.booking.id)).starts_at)).toBe(Date.parse(s.booking.starts_at));

  // Lease over: the next safety sync (16 minutes on) sees the same change again from the kept token and applies it.
  await admin().from("bookings").update({ google_change_until: null }).eq("id", s.booking.id);
  const response = await upkeep(baseURL!, s.host.id, Date.now() + 16 * 60_000);
  expect((await response.json()).calendar).toEqual({ renewed: 0, synced: 1, failed: 0 });
  expect(Date.parse((await bookingOf(s.booking.id)).starts_at)).toBe(Date.parse(moved.start));
  expect((await syncState(s.host.id)).sync_token).not.toBe(before.sync_token);
});

test("an unknown event from another install is skipped, and after a 410 the sync starts over and still applies a move", async ({ page, baseURL }) => {
  const s = await setUp(page, baseURL!);
  host = s.host;
  let before = await syncState(s.host.id);
  const foreign = { id: `other${randomUUID().replace(/-/g, "")}`, start: s.booking.starts_at, end: s.booking.ends_at, bookingId: s.booking.id };
  await control(s.host.email, "create", "", foreign);
  await syncedAfter(s.host.id, before.synced_at);
  // Skipped, and the token moved on.
  expect(await bookingOf(s.booking.id)).toMatchObject({ state: "booked" });
  expect((await syncState(s.host.id)).sync_token).not.toBe(before.sync_token);

  before = await syncState(s.host.id);
  await fetch(`${googleFakeUrl}/control/sync-gone?calendar=${encodeURIComponent(s.host.email)}`, { method: "POST" });
  const moved = { start: new Date(Date.parse(s.booking.starts_at) + 3 * hour).toISOString(), end: new Date(Date.parse(s.booking.ends_at) + 3 * hour).toISOString() };
  await control(s.host.email, "move", s.eventId, moved);
  await expect.poll(async () => Date.parse((await bookingOf(s.booking.id)).starts_at), { timeout: 15_000 }).toBe(Date.parse(moved.start));
});

test("the webhook answers 200 to anything, and syncs only for the right channel secret", async ({ page, baseURL }) => {
  const s = await setUp(page, baseURL!);
  host = s.host;
  const [channel] = await channels(s.host.email);
  const hook = (headers: Record<string, string>) => fetch(`${baseURL}/api/google/calendar-webhook`, { method: "POST", headers });
  const before = await syncState(s.host.id);

  expect((await hook({})).status).toBe(200);
  expect((await hook({ "x-goog-channel-id": channel.id, "x-goog-channel-token": "wrong", "x-goog-resource-state": "exists" })).status).toBe(200);
  expect((await hook({ "x-goog-channel-id": randomUUID(), "x-goog-channel-token": channel.token, "x-goog-resource-state": "exists" })).status).toBe(200);
  expect((await hook({ "x-goog-channel-id": channel.id, "x-goog-channel-token": channel.token, "x-goog-resource-state": "sync" })).status).toBe(200);
  await page.waitForTimeout(1500);
  expect((await syncState(s.host.id)).synced_at).toBe(before.synced_at);

  expect((await hook({ "x-goog-channel-id": channel.id, "x-goog-channel-token": channel.token, "x-goog-resource-state": "exists" })).status).toBe(200);
  await syncedAfter(s.host.id, before.synced_at);
});
