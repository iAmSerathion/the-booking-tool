import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { berlin, bookingsOf, fillDetails, newHost, nextDay, openDay, removeHost, zone } from "./booking-helpers";
import { webhookSecret, webhookUrl } from "./env";
import { admin } from "./session";

// Outbound webhooks end to end: the booking pages write outbox rows, POST /api/jobs/scheduler (scoped to the test's own
// booking with x-test-booking, on the test clock) delivers them to tests/e2e/webhook-receiver.mjs, signed and in order.

test.use({ timezoneId: zone, locale: "en-US" });

type Received = { headers: Record<string, string>; body: string; status: number };
const minute = 60_000;

const received = async (match: string): Promise<Received[]> => (await fetch(`${webhookUrl}/requests?match=${encodeURIComponent(match)}`)).json();
const failNext = (match: string, count: number) => fetch(`${webhookUrl}/control/fail?${new URLSearchParams({ match, count: String(count) })}`, { method: "POST" });
const dispatch = async (baseURL: string, bookingId: string, now = Date.now()) => {
  const response = await fetch(`${baseURL}/api/jobs/scheduler`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.SCHEDULER_SECRET}`, "x-test-now": new Date(now).toISOString(), "x-test-booking": bookingId },
  });
  expect(response.status).toBe(200);
  return (await response.json()).webhooks as { delivered: number; retry: number; failed: number };
};

// Verifies the signature the way the README tells receivers to, and returns the parsed body.
function verified(request: Received) {
  const expected = Buffer.from(`sha256=${createHmac("sha256", webhookSecret).update(request.body).digest("hex")}`);
  const given = Buffer.from(request.headers["x-signature"] ?? "");
  expect(given.length === expected.length && timingSafeEqual(given, expected)).toBe(true);
  const body = JSON.parse(request.body);
  expect(request.headers).toMatchObject({ "content-type": "application/json", "user-agent": "the-booking-tool", "x-webhook-id": body.id, "x-webhook-event": body.type });
  return body;
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });

async function book(page: Page, slug: string, day: string, time: string, email: string) {
  await page.goto(`/${slug}`);
  await (await openDay(page, day)).getByRole("button", { name: time }).click();
  await fillDetails(page, "Sam Invitee", email);
  await page.getByRole("button", { name: "Book this time" }).click();
  await expect(heading(page)).toHaveText("Your booking is confirmed.");
}

async function reschedule(page: Page, day: string, time: string) {
  await page.getByRole("link", { name: "Reschedule" }).click();
  await expect(heading(page)).toHaveText("Reschedule your booking");
  await (await openDay(page, day)).getByRole("button", { name: time }).click();
  await page.getByRole("button", { name: "Move to this time" }).click();
  await expect(heading(page)).toHaveText("Your booking is confirmed.");
}

async function cancel(page: Page) {
  await page.getByRole("link", { name: "Cancel booking" }).click();
  await expect(heading(page)).toHaveText("Cancel this booking?");
  await page.getByRole("button", { name: "Cancel booking" }).click();
  await expect(heading(page)).toHaveText("This booking was cancelled.");
}

test("a booking, a reschedule and a cancel each arrive once, signed and in order", async ({ page, baseURL }) => {
  const host = await newHost({ name: "Webhook Host" });
  const invitee = `invitee-${randomUUID()}@example.com`;
  try {
    const day = nextDay([1, 2, 3, 4, 5]);
    await book(page, host.slug, day, "9:00 AM", invitee);
    const [booking] = await bookingsOf(host.id);
    await reschedule(page, day, "2:00 PM");
    await cancel(page);

    expect(await dispatch(baseURL!, booking.id)).toEqual({ delivered: 3, retry: 0, failed: 0 });
    // A second run sends nothing more.
    expect(await dispatch(baseURL!, booking.id)).toEqual({ delivered: 0, retry: 0, failed: 0 });

    const requests = await received(booking.id);
    expect(requests.map((r) => r.status)).toEqual([200, 200, 200]);
    const bodies = requests.map(verified);
    expect(bodies.map((b) => b.type)).toEqual(["booking.created", "booking.rescheduled", "booking.cancelled"]);
    expect(new Set(bodies.map((b) => b.id)).size).toBe(3);

    const { data: row } = await admin().from("bookings").select("event_types (id, slug, title)").eq("id", booking.id).single();
    const eventType = row!.event_types;
    const [created, rescheduled, cancelled] = bodies;
    expect(Object.keys(created).sort()).toEqual(["booking", "created_at", "id", "type"]);
    expect(created.booking).toMatchObject({
      id: booking.id,
      state: "booked",
      host: { id: host.id, name: "Webhook Host", email: host.email },
      attendee: { name: "Sam Invitee", email: invitee, company: null, phone: null, timezone: zone },
      event_type: eventType,
      booked_via: "person_link",
      link: null,
    });
    expect(new Date(created.booking.starts_at).toISOString()).toBe(berlin(day, 9));
    expect(created.booking).not.toHaveProperty("token_hash");
    expect(created.booking).not.toHaveProperty("google_event_id");
    expect(rescheduled.booking).toMatchObject({ changed_by: "invitee", reschedule_count: 1 });
    expect(new Date(rescheduled.booking.starts_at).toISOString()).toBe(berlin(day, 14));
    expect(new Date(rescheduled.booking.previous.starts_at).toISOString()).toBe(berlin(day, 9));
    expect(cancelled.booking).toMatchObject({ state: "cancelled", cancelled_by: "invitee", changed_by: "invitee" });

    const { data: rows } = await admin().from("booking_outbox").select("id, attempts, last_error, delivered_at").eq("booking_id", booking.id).order("created_at");
    expect(rows!.map((r) => [r.id, r.attempts, r.last_error, r.delivered_at !== null])).toEqual(bodies.map((b) => [b.id, 1, null, true]));
  } finally {
    await removeHost(host.id);
  }
});

test("a failed delivery is retried after the backoff and delivered once; newer events of the booking wait for it", async ({ page, baseURL }) => {
  const host = await newHost({ name: "Retry Host" });
  const invitee = `invitee-${randomUUID()}@example.com`;
  try {
    // Matched by the invitee, so it already applies to the first delivery of the booking about to be made.
    await failNext(invitee, 1);
    const day = nextDay([1, 2, 3, 4, 5]);
    await book(page, host.slug, day, "10:00 AM", invitee);
    const [booking] = await bookingsOf(host.id);
    await cancel(page);

    const start = Date.now();
    expect(await dispatch(baseURL!, booking.id, start)).toEqual({ delivered: 0, retry: 1, failed: 0 });
    let requests = await received(booking.id);
    expect(requests.map((r) => [verified(r).type, r.status])).toEqual([["booking.created", 500]]);
    const { data: failed } = await admin().from("booking_outbox").select("type, attempts, last_error, delivered_at").eq("booking_id", booking.id).order("created_at");
    expect(failed).toEqual([
      { type: "booking.created", attempts: 1, last_error: "http 500", delivered_at: null },
      { type: "booking.cancelled", attempts: 0, last_error: null, delivered_at: null },
    ]);

    // Before the 1 minute backoff nothing goes out, not even the newer cancel.
    expect(await dispatch(baseURL!, booking.id, start + 30_000)).toEqual({ delivered: 0, retry: 0, failed: 0 });
    expect(await received(booking.id)).toHaveLength(1);

    // Past it: the created event is delivered, then the cancel, in that order.
    expect(await dispatch(baseURL!, booking.id, start + 2 * minute)).toEqual({ delivered: 2, retry: 0, failed: 0 });
    expect(await dispatch(baseURL!, booking.id, start + 10 * minute)).toEqual({ delivered: 0, retry: 0, failed: 0 });
    requests = await received(booking.id);
    const sent = requests.map((r) => ({ ...verified(r), status: r.status }));
    expect(sent.map((b) => [b.type, b.status])).toEqual([
      ["booking.created", 500],
      ["booking.created", 200],
      ["booking.cancelled", 200],
    ]);
    // The retry is the same event: same id, same body.
    expect(sent[1].id).toBe(sent[0].id);
    expect(requests[1].body).toBe(requests[0].body);
  } finally {
    await removeHost(host.id);
  }
});
