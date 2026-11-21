import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { bookingsOf, fillDetails, newHost, nextDay, openDay, removeHost, zone } from "./booking-helpers";
import { linkIn, mailsTo, waitForMails } from "./mail-helpers";
import { admin, signInAs } from "./session";

// The booking mails as tests/e2e/smtp-sink.mjs receives them over real SMTP. Every test has its own host and invitee
// addresses, so parallel tests never see each other's mails.

test.use({ timezoneId: zone, locale: "en-US" });

type Host = Awaited<ReturnType<typeof newHost>>;
const heading = (page: Page) => page.getByRole("heading", { level: 1 });

async function book(page: Page, host: Host, day: string, time: string, name: string, email: string) {
  await page.goto(`/${host.slug}`);
  await (await openDay(page, day)).getByRole("button", { name: time }).click();
  await fillDetails(page, name, email);
  await page.getByRole("button", { name: "Book this time" }).click();
  await expect(heading(page)).toHaveText("Your booking is confirmed.");
}

// Sorted by send_key here: the two mails of an occasion are written concurrently, and the database collation ignores ':'.
const outboundOf = async (bookingId: string) =>
  (await admin().from("outbound_mails").select("send_key, state, attempts").eq("booking_id", bookingId)).data!.sort((x, y) => (x.send_key < y.send_key ? -1 : 1));

test("a booking sends one confirmation and one host notice with working links; a new time and a cancel each send one mail to both sides", async ({ page, baseURL }) => {
  const host = await newHost({ name: "Morgan Host" });
  const invitee = `invitee-${randomUUID()}@example.com`;
  try {
    const day = nextDay([1, 2, 3, 4, 5]);
    await book(page, host, day, "9:00 AM", "Sam Invitee", invitee);
    const [booking] = await bookingsOf(host.id);

    const [confirmation] = await waitForMails(invitee, 1);
    const [notice] = await waitForMails(host.email, 1);
    expect(confirmation).toMatchObject({ from: "\"Bookings\" <bookings@example.com>", replyTo: host.email, subject: "Confirmed: Meeting with Morgan Host", attachments: [] });
    expect(confirmation.text).toContain("Hello Sam Invitee,\n\nyour booking is confirmed.");
    expect(confirmation.text).toContain("When: ");
    expect(confirmation.text).toContain(`Video call: ${booking.meet_url}`);
    expect(confirmation.text).toContain("The calendar invitation comes from Google in a separate email.");
    expect(confirmation.html).toContain(`<a href="${booking.meet_url}">`);
    expect(notice).toMatchObject({ replyTo: invitee });
    expect(notice.subject).toMatch(/^New booking: Sam Invitee, /);
    expect(notice.text).toContain(`Name: Sam Invitee\nEmail: ${invitee}`);
    expect(linkIn(notice, baseURL!)).toBe(`${baseURL}/app/bookings`);

    // The links come from APP_URL and work.
    const reschedule = linkIn(confirmation, `${baseURL}/reschedule/`);
    await page.goto(linkIn(confirmation, `${baseURL}/cancel/`));
    await expect(heading(page)).toHaveText("Cancel this booking?");
    await page.goto(reschedule);
    await expect(heading(page)).toHaveText("Reschedule your booking");

    // A new time: one mail to each side, with the time before.
    await (await openDay(page, day)).getByRole("button", { name: "2:00 PM" }).click();
    await page.getByRole("button", { name: "Move to this time" }).click();
    await expect(heading(page)).toHaveText("Your booking is confirmed.");
    const [, moved] = await waitForMails(invitee, 2);
    const [, movedNotice] = await waitForMails(host.email, 2);
    expect(moved.subject).toBe("New time: Meeting with Morgan Host");
    expect(moved.text).toMatch(/When: .*2:00 PM to 2:30 PM/);
    expect(moved.text).toMatch(/Before: .*9:00 AM to 9:30 AM/);
    expect(movedNotice.text).toContain("Sam Invitee moved the booking to a new time.");

    // Cancel through the mail's link: one mail to each side, the invitee's with a working rebook link.
    await page.goto(linkIn(moved, `${baseURL}/cancel/`));
    await page.getByLabel("Reason (optional)").fill("Travelling");
    await page.getByRole("button", { name: "Cancel booking" }).click();
    await expect(heading(page)).toHaveText("This booking was cancelled.");
    const [, , cancelled] = await waitForMails(invitee, 3);
    const [, , cancelledNotice] = await waitForMails(host.email, 3);
    expect(cancelled.subject).toBe("Cancelled: Meeting with Morgan Host");
    expect(cancelled.text).toContain("Reason: Travelling");
    expect(cancelledNotice.text).toContain("Sam Invitee cancelled the booking.");
    await page.goto(linkIn(cancelled, `${baseURL}/cancel/`));
    await expect(page).toHaveURL(/\/l\/[\w-]+$/);

    // Each occasion went out exactly once.
    expect(await mailsTo(invitee)).toHaveLength(3);
    expect(await mailsTo(host.email)).toHaveLength(3);
    expect((await outboundOf(booking.id)).map((m) => [m.send_key, m.state, m.attempts])).toEqual([
      [`cancelled:${booking.id}`, "sent", 1],
      [`cancelled_host:${booking.id}`, "sent", 1],
      [`confirmation:${booking.id}`, "sent", 1],
      [`host_notice:${booking.id}`, "sent", 1],
      [`rescheduled:${booking.id}:1`, "sent", 1],
      [`rescheduled_host:${booking.id}:1`, "sent", 1],
    ]);
  } finally {
    await removeHost(host.id);
  }
});

test("a host who cancels their own booking: only the invitee hears, with a rebook link", async ({ page, context, baseURL }) => {
  const host = await newHost({ name: "Quinn Host" });
  const invitee = `invitee-${randomUUID()}@example.com`;
  const name = `Lee ${randomUUID().slice(0, 8)}`;
  try {
    await book(page, host, nextDay([1, 2, 3, 4, 5]), "10:00 AM", name, invitee);
    await waitForMails(invitee, 1);
    await waitForMails(host.email, 1);

    await signInAs(context, baseURL!, host.email);
    await page.goto("/app/bookings");
    const card = page.getByRole("listitem").filter({ hasText: name });
    await card.getByRole("button", { name: `Cancel booking with ${name}` }).click();
    await card.getByRole("button", { name: "Yes, cancel booking" }).click();
    await expect(card).toHaveCount(0);

    const [, cancelled] = await waitForMails(invitee, 2);
    expect(cancelled.text).toContain("Quinn Host cancelled your booking.");
    const rebook = linkIn(cancelled, `${baseURL}/cancel/`);
    expect(rebook).toMatch(/\/new$/);
    await page.context().clearCookies();
    await page.goto(rebook);
    await expect(page).toHaveURL(/\/l\/[\w-]+$/);
    expect(await mailsTo(host.email)).toHaveLength(1);
    const [booking] = await bookingsOf(host.id);
    expect((await outboundOf(booking.id)).map((m) => m.send_key)).toEqual([`cancelled:${booking.id}`, `confirmation:${booking.id}`, `host_notice:${booking.id}`]);
  } finally {
    await removeHost(host.id);
  }
});
