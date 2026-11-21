import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { bookingsOf, fakeEvents, fillDetails, newHost, newPage, nextDay, noSideScroll, openDay, removeHost, zone } from "./booking-helpers";
import { admin, adminEmail, signInAs, userClient } from "./session";

// The admin Bookings page: upcoming bookings with answers and link metadata, host cancel, and RLS between members.
// Every test has its own hosts and fake calendars. The seeded admin sees every parallel test's bookings, so cards are
// found by their unique invitee name, never counted.

test.use({ timezoneId: zone, locale: "en-US" });

type Host = Awaited<ReturnType<typeof newHost>>;
const discoveryCall = "00000000-0000-4000-8000-000000000101";
const card = (page: Page, name: string) => page.getByRole("listitem").filter({ hasText: name });
const longDay = (day: string) => new Intl.DateTimeFormat("en", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(`${day}T12:00:00Z`));

// A booking with an answer and link metadata: a link seeded for the host, booked through "/l/<token>" with its prefill.
async function bookThroughLink(page: Page, host: Host, day: string, name: string) {
  const token = randomBytes(32).toString("base64url");
  const { error } = await admin()
    .from("booking_links")
    .insert({
      token_hash: createHash("sha256").update(token).digest("hex"),
      host_id: host.id,
      event_type_id: discoveryCall,
      prefill: { name, email: `invitee-${randomUUID()}@example.com`, answers: { topic: "Pricing" } },
      metadata: { campaign: "spring" },
    });
  if (error) throw error;
  await page.goto(`/l/${token}`);
  await (await openDay(page, day)).getByRole("button", { name: "9:00 AM" }).click();
  await page.waitForTimeout(3100); // the bot check wants more than three seconds between page load and submit
  await page.getByRole("button", { name: "Book this time" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your booking is confirmed.");
}

async function bookOnPage(page: Page, host: Host, day: string, name: string) {
  await page.goto(`/${host.slug}`);
  await (await openDay(page, day)).getByRole("button", { name: "10:00 AM" }).click();
  await fillDetails(page, name, `invitee-${randomUUID()}@example.com`);
  await page.getByRole("button", { name: "Book this time" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your booking is confirmed.");
}

const outboxOf = async (bookingId: string) =>
  (await admin().from("booking_outbox").select("type, payload").eq("booking_id", bookingId).order("created_at")).data as { type: string; payload: Record<string, unknown> }[];

test("a host sees their upcoming booking with answers and metadata and cancels it; others' bookings stay hidden; an admin cancels for any host", async ({ page, context, baseURL, browser }) => {
  const [hostA, hostB] = await Promise.all([newHost({ name: "Avery Host" }), newHost({ name: "Blake Host" })]);
  const invitee = await newPage(browser);
  const adminPage = await newPage(browser);
  try {
    const day = nextDay([1, 2, 3, 4, 5]);
    const nameA = `Ada ${randomUUID().slice(0, 8)}`;
    const nameB = `Bo ${randomUUID().slice(0, 8)}`;
    await bookThroughLink(invitee, hostA, day, nameA);
    await bookOnPage(invitee, hostB, day, nameB);
    const [bookingA] = await bookingsOf(hostA.id);
    const [bookingB] = await bookingsOf(hostB.id);

    // Host A: their booking with the answer and metadata, in their time zone; not host B's.
    await signInAs(context, baseURL!, hostA.email);
    await page.goto("/app");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Bookings" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bookings");
    const mine = card(page, nameA);
    await expect(mine).toContainText(`${longDay(day)}, 9:00 AM to 9:30 AM`);
    await expect(mine).toContainText("Discovery call");
    await expect(mine).toContainText("What would you like to talk about?");
    await expect(mine).toContainText("Pricing");
    await expect(mine).toContainText("campaign=spring");
    await expect(card(page, nameB)).toHaveCount(0);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await noSideScroll(page);
    }

    // RLS: host A can neither read nor cancel host B's booking.
    const asA = await userClient(hostA.email);
    expect((await asA.from("bookings").select("id").eq("id", bookingB.id)).data).toEqual([]);
    expect((await asA.rpc("cancel_booking_as_host", { p_booking_id: bookingB.id, p_reason: null })).error?.code).toBe("42501");
    expect((await bookingsOf(hostB.id))[0].state).toBe("booked");

    // Cancelling asks first: the first click only opens the confirmation, with focus in the reason field. "Keep booking"
    // closes it again, returns focus and leaves the booking untouched.
    const cancelA = mine.getByRole("button", { name: `Cancel booking with ${nameA}` });
    await expect(cancelA).toHaveAttribute("aria-expanded", "false");
    await cancelA.click();
    await expect(cancelA).toHaveAttribute("aria-expanded", "true");
    await expect(mine).toContainText(`Google Calendar tells ${nameA} right away that the booking is cancelled.`);
    await expect(mine.getByLabel("Reason (optional)")).toBeFocused();
    await mine.getByRole("button", { name: "Keep booking" }).click();
    await expect(cancelA).toHaveAttribute("aria-expanded", "false");
    await expect(cancelA).toBeFocused();
    await expect(mine.getByRole("button", { name: "Yes, cancel booking" })).toHaveCount(0);
    expect((await bookingsOf(hostA.id))[0].state).toBe("booked");

    // Host A cancels: gone from the list, cancelled by the host in the database and the outbox, event removed in Google.
    await cancelA.click();
    await mine.getByLabel("Reason (optional)").fill("Host is ill");
    await mine.getByRole("button", { name: "Yes, cancel booking" }).click();
    await expect(card(page, nameA)).toHaveCount(0);
    const { data: rowA } = await admin().from("bookings").select("state, cancelled_by").eq("id", bookingA.id).single();
    expect(rowA).toEqual({ state: "cancelled", cancelled_by: "host" });
    const outbox = await outboxOf(bookingA.id);
    expect(outbox.map((row) => row.type)).toEqual(["booking.created", "booking.cancelled"]);
    expect(outbox[1].payload).toMatchObject({ changed_by: "host", reason: "Host is ill", link: { metadata: { campaign: "spring" } } });
    const eventsA = await fakeEvents(hostA.email);
    expect(eventsA).toEqual([expect.objectContaining({ id: bookingA.google_event_id, status: "cancelled", deleteQuery: { sendUpdates: "all" } })]);

    // The admin sees host B's booking with its host and cancels it; the event goes from host B's calendar.
    await signInAs(adminPage.context(), baseURL!, adminEmail);
    await adminPage.goto("/app/bookings");
    const theirs = card(adminPage, nameB);
    await expect(theirs).toContainText("Blake Host");
    await theirs.getByRole("button", { name: `Cancel booking with ${nameB}` }).click();
    await theirs.getByRole("button", { name: "Yes, cancel booking" }).click();
    await expect(card(adminPage, nameB)).toHaveCount(0);
    expect((await admin().from("bookings").select("cancelled_by").eq("id", bookingB.id).single()).data).toEqual({ cancelled_by: "host" });
    expect(await fakeEvents(hostB.email)).toEqual([expect.objectContaining({ id: bookingB.google_event_id, status: "cancelled", deleteQuery: { sendUpdates: "all" } })]);
  } finally {
    await Promise.all([invitee.context().close(), adminPage.context().close()]);
    await Promise.all([removeHost(hostA.id), removeHost(hostB.id)]);
  }
});
