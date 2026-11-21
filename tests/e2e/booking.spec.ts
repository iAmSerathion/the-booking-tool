import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { berlin, bookingsOf, dayLabel, fakeEvents, fillDetails, liveEvents, newHost, newPage, nextDay, noSideScroll, openDay, removeHost, setBusy, type Window, zone } from "./booking-helpers";
import { googleFakeUrl } from "./env";
import { admin } from "./session";

// The M4 acceptance tests: invitees book through the public pages, Google is the fake (tests/e2e/google-fake.mjs).
// Every test creates its own hosts with their own fake calendars (the primary calendar id is the host's email), so the
// fake's state and the database rows never collide with parallel tests. The seeded demo host is left alone because
// settings.spec connects and disconnects its calendar. The helpers live in booking-helpers.ts.

test.use({ timezoneId: zone, locale: "en-US" });

test("an invitee books on a member page: booking row, outbox row, Google event with Meet; the time cannot be booked twice", async ({ page, browser }) => {
  const host = await newHost({ name: "Avery Host" });
  const other = await newPage(browser);
  try {
    const day = nextDay([1, 2, 3, 4, 5]);
    // Busy 10:00-10:30 at Google; with the 15 minute buffer 9:30 and 10:30 go too.
    await setBusy(host.email, [{ start: berlin(day, 10), end: berlin(day, 10, 30) }]);

    await page.goto(`/${host.slug}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Meeting");
    await expect(page.getByText("with Avery Host")).toBeVisible();
    await expect(page.getByText("Google Meet")).toBeVisible();
    await expect(page.getByLabel("Time zone")).toHaveValue(zone);
    const times = await openDay(page, day);
    await expect(times.getByRole("button")).toHaveText(["9:00 AM", "11:00 AM", "11:30 AM", "2:00 PM", "2:30 PM", "3:00 PM", "3:30 PM", "4:00 PM", "4:30 PM"]);
    await noSideScroll(page);

    // A second invitee opens the same time before the first one books it.
    await other.goto(`/${host.slug}`);
    await (await openDay(other, day)).getByRole("button", { name: "9:00 AM" }).click();

    // Empty details are caught before anything is sent.
    await times.getByRole("button", { name: "9:00 AM" }).click();
    await expect(times.getByRole("button", { name: "9:00 AM" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Book this time" }).click();
    await expect(page.getByText("Please enter your name.")).toBeVisible();
    await expect(page.getByLabel("Name", { exact: true })).toBeFocused();

    const email = `invitee-${randomUUID()}@example.com`;
    await fillDetails(page, "Robin Invitee", email);
    await expect(page.getByText(/^Selected time: .*9:00\sAM to 9:30\sAM$/)).toBeVisible();
    await page.getByRole("button", { name: "Book this time" }).click();

    await expect(page).toHaveURL(/\/confirmed\/[\w-]{43}\?new=1$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your booking is confirmed.");
    await expect(page.getByText(`${new Intl.DateTimeFormat("en", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(`${day}T12:00:00Z`))}, 9:00 AM to 9:30 AM`)).toBeVisible();
    await expect(page.getByText("Avery Host", { exact: true })).toBeVisible();
    const meetLink = page.getByRole("link", { name: "Join with Google Meet" });
    await expect(meetLink).toHaveAttribute("href", /^https:\/\/meet\.google\.com\//);

    const [booking, ...more] = await bookingsOf(host.id);
    expect(more).toEqual([]);
    expect(booking).toMatchObject({ booked_via: "person_link", invitee_email: email, state: "booked" });
    expect(new Date(booking.starts_at).toISOString()).toBe(berlin(day, 9));
    expect(new Date(booking.ends_at).toISOString()).toBe(berlin(day, 9, 30));
    expect(booking.meet_url).toBe(await meetLink.getAttribute("href"));

    const { data: outbox } = await admin().from("booking_outbox").select("type").eq("booking_id", booking.id);
    expect(outbox).toEqual([{ type: "booking.created" }]);

    const [event, ...extra] = await liveEvents(host.email);
    expect(extra).toEqual([]);
    expect(event).toMatchObject({
      id: booking.google_event_id,
      query: { sendUpdates: "all", conferenceDataVersion: "1" },
      attendees: [{ email, displayName: "Robin Invitee" }],
      extendedProperties: { private: { booking_id: booking.id } },
      hangoutLink: booking.meet_url,
    });

    // The second invitee is told the time is gone, keeps their details, and nothing more is booked.
    await fillDetails(other, "Sam Second", `second-${randomUUID()}@example.com`);
    await other.getByRole("button", { name: "Book this time" }).click();
    await expect(other.getByRole("main").getByRole("alert")).toHaveText("This time was just taken. Please choose another.");
    await expect(other.getByLabel("Name", { exact: true })).toHaveValue("Sam Second");
    // No time is selected any more, and the fresh times leave the taken one out.
    const otherTimes = other.getByRole("group", { name: `Free times on ${dayLabel(day)}` });
    await expect(otherTimes.getByRole("button", { pressed: true })).toHaveCount(0);
    await expect(otherTimes.getByRole("button", { name: "9:00 AM" })).toHaveCount(0);
    expect(await liveEvents(host.email)).toHaveLength(1);
    expect(await bookingsOf(host.id)).toHaveLength(1);

    // A fresh page no longer offers the booked time.
    await page.goto(`/${host.slug}`);
    await expect((await openDay(page, day)).getByRole("button", { name: "9:00 AM" })).toHaveCount(0);
  } finally {
    await other.context().close();
    await removeHost(host.id);
  }
});

test("when Google fails nothing is booked, and the time can be booked right after", async ({ page }) => {
  const host = await newHost({ meetAuto: false });
  try {
    const day = nextDay([1, 2, 3, 4, 5]);
    await page.goto(`/${host.slug}`);
    await expect(page.getByText("Google Meet")).toHaveCount(0);
    await (await openDay(page, day)).getByRole("button", { name: "11:00 AM" }).click();
    await fillDetails(page, "Robin Invitee", `invitee-${randomUUID()}@example.com`);

    await fetch(`${googleFakeUrl}/control/fail-insert?calendar=${encodeURIComponent(host.email)}&count=1`, { method: "POST" });
    await page.getByRole("button", { name: "Book this time" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(/^That did not work, nothing was booked\./);
    expect(await bookingsOf(host.id)).toEqual([]);
    expect(await fakeEvents(host.email)).toEqual([]);

    // The hold was released, so the same time books at once. Without meet_auto there is no Meet link.
    await page.getByRole("button", { name: "Book this time" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your booking is confirmed.");
    await expect(page.getByText("The details are in the calendar invitation.")).toBeVisible();
    const [booking] = await bookingsOf(host.id);
    expect(booking.meet_url).toBeNull();
    expect((await liveEvents(host.email))[0].conferenceData).toBeUndefined();
  } finally {
    await removeHost(host.id);
  }
});

test("when the Google insert response is lost the created event is taken back and a retry books once", async ({ page }) => {
  const host = await newHost({ meetAuto: false });
  try {
    await page.goto(`/${host.slug}`);
    await (await openDay(page, nextDay([1, 2, 3, 4, 5]))).getByRole("button", { name: "11:00 AM" }).click();
    await fillDetails(page, "Robin Invitee", `invitee-${randomUUID()}@example.com`);

    // Google creates the event, but the answer is a 503: the action cannot know the id from the response.
    await fetch(`${googleFakeUrl}/control/lose-insert?calendar=${encodeURIComponent(host.email)}&count=1`, { method: "POST" });
    await page.getByRole("button", { name: "Book this time" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("nothing was booked");
    expect(await bookingsOf(host.id)).toEqual([]);
    const events = await fakeEvents(host.email);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "cancelled", deleteQuery: { sendUpdates: "none" } });
    expect(await liveEvents(host.email)).toEqual([]);

    await page.getByRole("button", { name: "Book this time" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your booking is confirmed.");
    expect(await liveEvents(host.email)).toHaveLength(1);
  } finally {
    await removeHost(host.id);
  }
});

test("round robin on the general page gives the time to the free host booked least recently", async ({ page }) => {
  // Sunday 05:00-06:00 only: no other host (seeded or from other specs) offers that time. Two copies of this test at once
  // (--repeat-each) would share it.
  const sunday: Window[] = [{ weekday: 7, start_time: "05:00", end_time: "06:00" }];
  const tag = randomUUID().slice(0, 8);
  const busy = await newHost({ name: `RR A ${tag}`, windows: sunday });
  const recent = await newHost({ name: `RR B ${tag}`, windows: sunday });
  const free = await newHost({ name: `RR C ${tag}`, windows: sunday });
  try {
    const day = nextDay([7]);
    // A is busy at Google; B had a page booking a moment ago (cancelled ones count too); C never had one.
    await setBusy(busy.email, [{ start: berlin(day, 4), end: berlin(day, 7) }]);
    const { data: type } = await admin().from("settings").select("value").eq("key", "default_event_type_id").single();
    const { error } = await admin().from("bookings").insert({
      event_type_id: type!.value,
      host_id: recent.id,
      starts_at: "2026-01-05T09:00:00Z",
      ends_at: "2026-01-05T09:30:00Z",
      state: "cancelled",
      cancelled_by: "host",
      booked_via: "page",
      invitee_name: "Earlier Invitee",
      invitee_email: `earlier-${tag}@example.com`,
    });
    if (error) throw error;

    await page.goto("/");
    await (await openDay(page, day)).getByRole("button", { name: "5:00 AM" }).click();
    await fillDetails(page, "Robin Invitee", `invitee-${randomUUID()}@example.com`);
    await page.getByRole("button", { name: "Book this time" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your booking is confirmed.");
    await expect(page.getByText(free.name, { exact: true })).toBeVisible();

    const [booking] = await bookingsOf(free.id);
    expect(booking).toMatchObject({ booked_via: "page", state: "booked" });
    expect(new Date(booking.starts_at).toISOString()).toBe(berlin(day, 5));
    expect(await liveEvents(free.email)).toHaveLength(1);
    expect(await liveEvents(busy.email)).toEqual([]);
    expect(await liveEvents(recent.email)).toEqual([]);
  } finally {
    await Promise.all([busy, recent, free].map((h) => removeHost(h.id)));
  }
});

test("the booking pages hydrate without console errors, and the time zone list fills in after mount", async ({ page }) => {
  const host = await newHost();
  try {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (message) => message.type() === "error" && problems.push(`console: ${message.text()}`));
    for (const path of ["/", `/${host.slug}`]) {
      await page.goto(path);
      // Before mount the select has one option; the browser's zones follow once React has hydrated.
      await expect.poll(() => page.getByLabel("Time zone").locator("option").count()).toBeGreaterThan(100);
      await expect(page.getByLabel("Time zone")).toHaveValue(zone);
    }
    expect(problems).toEqual([]);
  } finally {
    await removeHost(host.id);
  }
});

test("unknown member pages and confirmation tokens show the translated 404 page in the brand frame", async ({ page }) => {
  for (const path of [`/nobody-${randomUUID().slice(0, 8)}`, `/confirmed/${"A".repeat(43)}`, "/confirmed/not-a-token"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
    await expect(page.getByText("This page does not exist or the link is no longer valid.")).toBeVisible();
    await expect(page.getByText("Acme Bookings", { exact: true })).toBeVisible();
    await expect(page.getByText("This page could not be found.")).toHaveCount(0);
  }
});

for (const width of [390, 1440]) {
  test(`the member page fits ${width}px without sideways scrolling`, async ({ page }) => {
    const host = await newHost();
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/${host.slug}`);
      await (await openDay(page, nextDay([1, 2, 3, 4, 5]))).getByRole("button").first().click();
      await expect(page.getByRole("button", { name: "Book this time" })).toBeVisible();
      await noSideScroll(page);
    } finally {
      await removeHost(host.id);
    }
  });
}
