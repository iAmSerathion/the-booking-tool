import { createHash, randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { berlin, bookingsOf, dayLabel, fakeEvents, fillDetails, liveEvents, newHost, newPage, nextDay, noSideScroll, openDay, removeHost, zone } from "./booking-helpers";
import { googleFakeUrl } from "./env";
import { admin } from "./session";

// The M5 acceptance tests for the invitee's token links: reschedule, cancel, the closed view and "book a new time".
// Every test has its own host and fake calendar, so parallel tests never share rows or events.

test.use({ timezoneId: zone, locale: "en-US" });

type Host = Awaited<ReturnType<typeof newHost>>;

// Books a time on the host's page and returns the invitee token from the confirmation URL.
async function book(page: Page, host: Host, day: string, time: string, name = "Robin Invitee") {
  await page.goto(`/${host.slug}`);
  await (await openDay(page, day)).getByRole("button", { name: time }).click();
  await fillDetails(page, name, `invitee-${randomUUID()}@example.com`);
  await page.getByRole("button", { name: "Book this time" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your booking is confirmed.");
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

const longDay = (day: string) => new Intl.DateTimeFormat("en", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(`${day}T12:00:00Z`));
const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const alert = (page: Page) => page.getByRole("main").getByRole("alert");
const iso = (value: string) => new Date(value).toISOString();
const outboxOf = async (bookingId: string) =>
  (await admin().from("booking_outbox").select("type, payload").eq("booking_id", bookingId).order("created_at")).data as { type: string; payload: Record<string, unknown> }[];

test("an invitee reschedules through the token link: same booking and event, moved in Google, outbox row; a failed move changes nothing", async ({ page }) => {
  const host = await newHost({ name: "Riley Host" });
  try {
    const day = nextDay([1, 2, 3, 4, 5]);
    const token = await book(page, host, day, "9:00 AM");
    const [before] = await bookingsOf(host.id);

    await page.getByRole("link", { name: "Reschedule" }).click();
    await expect(page).toHaveURL(new RegExp(`/reschedule/${token}$`));
    await expect(heading(page)).toHaveText("Reschedule your booking");
    await expect(page.getByText(`${longDay(day)}, 9:00 AM to 9:30 AM`)).toBeVisible();
    const times = await openDay(page, day);
    // The current time is not offered. The booking does not block itself: 9:30 is free despite the 15 minute buffer.
    await expect(times.getByRole("button", { name: "9:00 AM" })).toHaveCount(0);
    await expect(times.getByRole("button", { name: "9:30 AM" })).toBeVisible();

    await page.getByRole("button", { name: "Move to this time" }).click();
    await expect(alert(page)).toHaveText("Please choose a time first.");

    // Google refuses the move once: nothing changes, and the hold is released so the same time works right after.
    await times.getByRole("button", { name: "2:00 PM" }).click();
    await fetch(`${googleFakeUrl}/control/fail-patch?calendar=${encodeURIComponent(host.email)}&count=1`, { method: "POST" });
    await page.getByRole("button", { name: "Move to this time" }).click();
    await expect(alert(page)).toHaveText("That did not work, your booking was not moved. Please try again.");
    const { data: unchanged } = await admin().from("bookings").select("starts_at, reschedule_count, google_change_until").eq("id", before.id).single();
    expect(unchanged).toMatchObject({ reschedule_count: 0, google_change_until: null });
    expect(iso(unchanged!.starts_at)).toBe(berlin(day, 9));

    await page.getByRole("button", { name: "Move to this time" }).click();
    await expect(page).toHaveURL(new RegExp(`/confirmed/${token}$`));
    await expect(heading(page)).toHaveText("Your booking is confirmed.");
    await expect(page.getByText(`${longDay(day)}, 2:00 PM to 2:30 PM`)).toBeVisible();

    const { data: after } = await admin().from("bookings").select("*").eq("id", before.id).single();
    expect(after).toMatchObject({ state: "booked", reschedule_count: 1, google_event_id: before.google_event_id, meet_url: before.meet_url, invitee_timezone: zone, google_change_until: null });
    expect([iso(after!.starts_at), iso(after!.ends_at)]).toEqual([berlin(day, 14), berlin(day, 14, 30)]);
    expect(await bookingsOf(host.id)).toHaveLength(1);

    const [event, ...others] = await liveEvents(host.email);
    expect(others).toEqual([]);
    expect(event).toMatchObject({ id: before.google_event_id, hangoutLink: before.meet_url, start: { dateTime: berlin(day, 14) }, end: { dateTime: berlin(day, 14, 30) } });
    expect(event.patches).toEqual([{ body: { start: { dateTime: berlin(day, 14), timeZone: zone }, end: { dateTime: berlin(day, 14, 30), timeZone: zone } }, query: { sendUpdates: "all" } }]);

    const outbox = await outboxOf(before.id);
    expect(outbox.map((row) => row.type)).toEqual(["booking.created", "booking.rescheduled"]);
    const previous = outbox[1].payload.previous as { starts_at: string; ends_at: string };
    expect([iso(previous.starts_at), iso(previous.ends_at)]).toEqual([berlin(day, 9), berlin(day, 9, 30)]);
    expect(outbox[1].payload).toMatchObject({ changed_by: "invitee", reschedule_count: 1 });

    // The old time is free again; the new one is taken.
    await page.goto(`/${host.slug}`);
    const fresh = await openDay(page, day);
    await expect(fresh.getByRole("button", { name: "9:00 AM" })).toBeVisible();
    await expect(fresh.getByRole("button", { name: "2:00 PM" })).toHaveCount(0);
  } finally {
    await removeHost(host.id);
  }
});

test("an invitee cancels with a reason: Google event removed, outbox row, closed view everywhere, and a prefilled single-use link to book again", async ({ page, browser }) => {
  const host = await newHost({ name: "Casey Host" });
  const second = await newPage(browser);
  try {
    const day = nextDay([1, 2, 3, 4, 5]);
    const token = await book(page, host, day, "11:00 AM", "Jordan Invitee");
    const [booking] = await bookingsOf(host.id);
    // A second tab opens the cancel form too, to click it after the first one.
    await second.goto(`/cancel/${token}`);

    await page.getByRole("link", { name: "Cancel booking" }).click();
    await expect(heading(page)).toHaveText("Cancel this booking?");
    await expect(page.getByText(`${longDay(day)}, 11:00 AM to 11:30 AM`)).toBeVisible();
    await page.getByLabel("Reason (optional)").fill("  Something came up  ");
    await page.getByRole("button", { name: "Cancel booking" }).click();
    await expect(page).toHaveURL(new RegExp(`/cancel/${token}$`));
    await expect(heading(page)).toHaveText("This booking was cancelled.");
    await expect(page.getByText("You can book a new time with the same person.")).toBeVisible();

    const { data: row } = await admin().from("bookings").select("state, cancelled_by, event_type_id, invitee_email").eq("id", booking.id).single();
    expect(row).toMatchObject({ state: "cancelled", cancelled_by: "invitee" });
    const [event] = await fakeEvents(host.email);
    expect(event).toMatchObject({ id: booking.google_event_id, status: "cancelled", deleteQuery: { sendUpdates: "all" } });
    const cancelled = async () => (await outboxOf(booking.id)).filter((r) => r.type === "booking.cancelled");
    expect((await cancelled()).map((r) => r.payload)).toEqual([expect.objectContaining({ reason: "Something came up", changed_by: "invitee", state: "cancelled" })]);

    // The second tab's submit lands on the closed view; nothing is cancelled twice.
    await second.getByRole("button", { name: "Cancel booking" }).click();
    await expect(heading(second)).toHaveText("This booking was cancelled.");
    expect(await cancelled()).toHaveLength(1);

    // The reschedule and confirmation pages are closed too, with only "Book a new time" left.
    await page.goto(`/reschedule/${token}`);
    await expect(heading(page)).toHaveText("This booking was cancelled.");
    await expect(page.getByRole("button", { name: "Move to this time" })).toHaveCount(0);
    await page.goto(`/confirmed/${token}`);
    await expect(heading(page)).toHaveText("This booking was cancelled.");
    await expect(page.getByRole("link", { name: "Reschedule" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Cancel booking" })).toHaveCount(0);

    // The time is free again.
    await page.goto(`/${host.slug}`);
    await expect((await openDay(page, day)).getByRole("button", { name: "11:00 AM" })).toBeVisible();

    await page.goto(`/confirmed/${token}`);
    await page.getByRole("link", { name: "Book a new time" }).click();
    await expect(page).toHaveURL(/\/l\/[\w-]{43}$/);
    const link = new URL(page.url()).pathname.split("/").at(-1)!;
    const { data: links } = await admin().from("booking_links").select("*").eq("token_hash", createHash("sha256").update(link).digest("hex"));
    expect(links).toEqual([
      expect.objectContaining({
        host_id: host.id,
        event_type_id: row!.event_type_id,
        single_use: true,
        used_at: null,
        expires_at: null,
        prefill: { name: "Jordan Invitee", email: row!.invitee_email, timezone: zone },
        metadata: { rebook_of: booking.id },
      }),
    ]);
  } finally {
    await second.context().close();
    await removeHost(host.id);
  }
});

test("a booking that has started shows the closed view and offers no changes", async ({ page }) => {
  const host = await newHost();
  try {
    const token = await book(page, host, nextDay([1, 2, 3, 4, 5]), "9:00 AM");
    const [booking] = await bookingsOf(host.id);
    const { error } = await admin()
      .from("bookings")
      .update({ starts_at: new Date(Date.now() - 3_600_000).toISOString(), ends_at: new Date(Date.now() + 600_000).toISOString() })
      .eq("id", booking.id);
    if (error) throw error;

    for (const path of [`/reschedule/${token}`, `/cancel/${token}`]) {
      await page.goto(path);
      await expect(heading(page)).toHaveText("This booking has already started or is over.");
      await expect(page.getByText("It can no longer be changed.")).toBeVisible();
      await expect(page.getByRole("button")).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Book a new time" })).toHaveCount(0);
    }
    await page.goto(`/confirmed/${token}`);
    await expect(page.getByRole("link", { name: "Reschedule" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Cancel booking" })).toHaveCount(0);
    // Not cancelled: "book a new time" sends the invitee back to the confirmation and creates no link.
    await page.goto(`/cancel/${token}/new`);
    await expect(page).toHaveURL(new RegExp(`/confirmed/${token}$`));
    expect((await admin().from("booking_links").select("id").eq("host_id", host.id)).data).toEqual([]);
  } finally {
    await removeHost(host.id);
  }
});

test("unknown or malformed change tokens show the translated 404 page", async ({ page }) => {
  const unknown = "A".repeat(43);
  for (const path of [`/reschedule/${unknown}`, `/cancel/${unknown}`, `/cancel/${unknown}/new`, "/reschedule/not-a-token", "/cancel/not-a-token"]) {
    // Streamed pages keep status 200 once rendering started (as /confirmed does); the text is what the invitee sees.
    await page.goto(path);
    await expect(heading(page)).toHaveText("Page not found");
    await expect(page.getByText("This page does not exist or the link is no longer valid.")).toBeVisible();
  }
});

test("the reschedule and cancel pages fit 390px and 1440px without sideways scrolling", async ({ page }) => {
  const host = await newHost();
  try {
    const day = nextDay([1, 2, 3, 4, 5]);
    const token = await book(page, host, day, "9:00 AM");
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/reschedule/${token}`);
      await (await openDay(page, day)).getByRole("button").first().click();
      await expect(page.getByRole("button", { name: "Move to this time" })).toBeVisible();
      await expect(page.getByRole("group", { name: `Free times on ${dayLabel(day)}` })).toBeVisible();
      await noSideScroll(page);
      await page.goto(`/cancel/${token}`);
      await expect(page.getByLabel("Reason (optional)")).toBeVisible();
      await noSideScroll(page);
    }
  } finally {
    await removeHost(host.id);
  }
});
