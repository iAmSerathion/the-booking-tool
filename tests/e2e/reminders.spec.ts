import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { bookingsOf, fillDetails, newHost, nextDay, openDay, removeHost, zone } from "./booking-helpers";
import { linkIn, mailsTo } from "./mail-helpers";
import { admin } from "./session";

// Reminder jobs end to end: planned after booking, re-planned after a reschedule, cancelled with the booking, and run by
// POST /api/jobs/scheduler on a simulated clock (x-test-now), always scoped to the test's own booking (x-test-booking),
// so parallel tests never run each other's jobs.

test.use({ timezoneId: zone, locale: "en-US" });

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const minute = 60_000;

function scheduler(baseURL: string, headers: Record<string, string>) {
  return fetch(`${baseURL}/api/jobs/scheduler`, { method: "POST", headers: { authorization: `Bearer ${process.env.SCHEDULER_SECRET}`, ...headers } });
}
const runAt = (baseURL: string, bookingId: string, now: number) =>
  scheduler(baseURL, { "x-test-now": new Date(now).toISOString(), "x-test-booking": bookingId });

const jobsOf = async (bookingId: string) =>
  (await admin().from("booking_jobs").select("step_key, run_at, planned_for, state").eq("booking_id", bookingId).order("created_at").order("run_at")).data!;
const plannedOf = async (bookingId: string) => (await jobsOf(bookingId)).filter((j) => j.state === "planned");
const remindersTo = async (address: string) => (await mailsTo(address)).filter((m) => m.subject.startsWith("Reminder:"));

async function book(page: Page, slug: string, day: string, time: string, email: string) {
  await page.goto(`/${slug}`);
  await (await openDay(page, day)).getByRole("button", { name: time }).click();
  await fillDetails(page, "Sam Invitee", email);
  await page.getByRole("button", { name: "Book this time" }).click();
  await expect(heading(page)).toHaveText("Your booking is confirmed.");
}

// Planning runs in after(), shortly after the page answered.
async function waitForPlan(bookingId: string, startsAt: string) {
  const start = Date.parse(startsAt);
  await expect
    .poll(async () => (await plannedOf(bookingId)).map((j) => [j.step_key, Date.parse(j.run_at), Date.parse(j.planned_for)]), { timeout: 15_000 })
    .toEqual([
      ["reminder_1440m", start - 1440 * minute, start],
      ["reminder_60m", start - 60 * minute, start],
    ]);
}

test("the scheduler sends the 24 h reminder once, with working links; a reschedule plans the reminders for the new time", async ({ page, baseURL }) => {
  const host = await newHost({ name: "Avery Host" });
  const invitee = `invitee-${randomUUID()}@example.com`;
  try {
    const day = nextDay([1, 2, 3, 4, 5]);
    await book(page, host.slug, day, "9:00 AM", invitee);
    const [booking] = await bookingsOf(host.id);
    await waitForPlan(booking.id, booking.starts_at);
    const start = Date.parse(booking.starts_at);

    // Just before the 24 h reminder is due: nothing.
    let response = await runAt(baseURL!, booking.id, start - 1440 * minute - minute);
    expect(response.status).toBe(200);
    expect((await response.json()).jobs).toMatchObject({ done: 0 });

    // A minute after: the 24 h reminder goes out, the 1 h one stays planned.
    response = await runAt(baseURL!, booking.id, start - 1440 * minute + minute);
    expect((await response.json()).jobs).toEqual({ done: 1, cancelled: 0, retry: 0, failed: 0 });
    expect((await jobsOf(booking.id)).map((j) => [j.step_key, j.state])).toEqual([
      ["reminder_1440m", "done"],
      ["reminder_60m", "planned"],
    ]);
    const [reminder] = await remindersTo(invitee);
    expect(reminder).toMatchObject({ subject: "Reminder: Meeting with Avery Host", replyTo: host.email });
    expect(reminder.text).toContain("a reminder of your upcoming booking.");
    expect(reminder.text).toContain(`Video call: ${booking.meet_url}`);

    // The same run again sends nothing more.
    response = await runAt(baseURL!, booking.id, start - 1440 * minute + minute);
    expect((await response.json()).jobs).toMatchObject({ done: 0 });
    expect(await remindersTo(invitee)).toHaveLength(1);
    const { data: rows } = await admin().from("outbound_mails").select("send_key, kind, state").eq("booking_id", booking.id).like("kind", "reminder%");
    expect(rows).toEqual([{ send_key: `reminder_1440m:${booking.id}:${new Date(start).toISOString()}`, kind: "reminder_1440m", state: "sent" }]);

    // The reminder's own links come from APP_URL and work: move the booking through them.
    await page.goto(linkIn(reminder, `${baseURL}/cancel/`));
    await expect(heading(page)).toHaveText("Cancel this booking?");
    await page.goto(linkIn(reminder, `${baseURL}/reschedule/`));
    await expect(heading(page)).toHaveText("Reschedule your booking");
    await (await openDay(page, day)).getByRole("button", { name: "2:00 PM" }).click();
    await page.getByRole("button", { name: "Move to this time" }).click();
    await expect(heading(page)).toHaveText("Your booking is confirmed.");

    // Old jobs cancelled, new ones planned for the new start; the 24 h reminder goes out again for the new time.
    const [moved] = await bookingsOf(host.id);
    await waitForPlan(booking.id, moved.starts_at);
    expect((await jobsOf(booking.id)).slice(0, 2).map((j) => j.state)).toEqual(["done", "cancelled"]);
    const newStart = Date.parse(moved.starts_at);
    response = await runAt(baseURL!, booking.id, newStart - 1440 * minute + minute);
    expect((await response.json()).jobs).toMatchObject({ done: 1 });
    expect(await remindersTo(invitee)).toHaveLength(2);
  } finally {
    await removeHost(host.id);
  }
});

test("a cancelled booking gets no reminder", async ({ page, baseURL }) => {
  const host = await newHost({ name: "Blake Host" });
  const invitee = `invitee-${randomUUID()}@example.com`;
  try {
    await book(page, host.slug, nextDay([1, 2, 3, 4, 5]), "10:00 AM", invitee);
    const [booking] = await bookingsOf(host.id);
    await waitForPlan(booking.id, booking.starts_at);

    const { error } = await admin().rpc("cancel_booking", { p_booking_id: booking.id, p_cancelled_by: "invitee", p_reason: null });
    expect(error).toBeNull();
    expect((await jobsOf(booking.id)).map((j) => j.state)).toEqual(["cancelled", "cancelled"]);

    const start = Date.parse(booking.starts_at);
    for (const offset of [1440, 60]) {
      const response = await runAt(baseURL!, booking.id, start - offset * minute + minute);
      expect((await response.json()).jobs).toMatchObject({ done: 0 });
    }
    expect(await remindersTo(invitee)).toEqual([]);
  } finally {
    await removeHost(host.id);
  }
});

test("the scheduler refuses a missing or wrong secret, and a test clock without a scope", async ({ baseURL }) => {
  const url = `${baseURL}/api/jobs/scheduler`;
  expect((await fetch(url, { method: "POST" })).status).toBe(401);
  expect((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${"x".repeat(48)}` } })).status).toBe(401);
  expect((await fetch(url, { method: "POST", headers: { authorization: process.env.SCHEDULER_SECRET! } })).status).toBe(401);

  let response = await scheduler(baseURL!, { "x-test-now": new Date().toISOString() });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "x-test-now needs x-test-booking or x-test-user" });
  response = await scheduler(baseURL!, { "x-test-now": "soon", "x-test-booking": randomUUID() });
  expect(response.status).toBe(400);
  response = await scheduler(baseURL!, { "x-test-now": new Date().toISOString(), "x-test-booking": "not-a-uuid" });
  expect(response.status).toBe(400);
});
