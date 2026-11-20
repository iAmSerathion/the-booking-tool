import { randomUUID } from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { googleFakeUrl } from "./env";
import { admin } from "./session";

// The M4 acceptance tests: invitees book through the public pages, Google is the fake (tests/e2e/google-fake.mjs).
// Every test creates its own hosts with their own fake calendars (the primary calendar id is the host's email), so the
// fake's state and the database rows never collide with parallel tests. The seeded demo host is left alone because
// settings.spec connects and disconnects its calendar.

const calendarScope = "https://www.googleapis.com/auth/calendar";
const zone = "Europe/Berlin";
test.use({ timezoneId: zone, locale: "en-US" });

type Window = { weekday: number; start_time: string; end_time: string };

async function newHost({ name = "Booking Host", meetAuto = true, windows }: { name?: string; meetAuto?: boolean; windows?: Window[] } = {}) {
  const email = `booking-${randomUUID()}@example.com`;
  const slug = `host-${randomUUID().slice(0, 12)}`;
  const { data, error } = await admin().auth.admin.createUser({ email, email_confirm: true });
  if (error) throw error;
  const id = data.user.id;
  const { error: profileError } = await admin().from("profiles").insert({ id, name, email, slug, timezone: zone, bookable: true, meet_auto: meetAuto });
  if (profileError) throw profileError;
  if (windows) {
    // The insert trigger added the default windows (weekdays); replace them.
    await admin().from("availability_windows").delete().eq("user_id", id);
    const { error: windowError } = await admin().from("availability_windows").insert(windows.map((w) => ({ ...w, user_id: id })));
    if (windowError) throw windowError;
  }
  // Consent and code exchange at the fake, as the settings page would do, then store the connection.
  const redirectUri = "http://127.0.0.1/e2e-callback";
  const consent = await fetch(
    `${googleFakeUrl}/o/oauth2/v2/auth?${new URLSearchParams({ client_id: "fake-client", redirect_uri: redirectUri, login_hint: email, scope: calendarScope })}`,
    { redirect: "manual" },
  );
  const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;
  const tokens = await fetch(`${googleFakeUrl}/token`, {
    method: "POST",
    body: new URLSearchParams({ client_id: "fake-client", client_secret: "fake-secret", grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  }).then((r) => r.json());
  const { error: saveError } = await admin().rpc("google_connection_save", {
    p_user_id: id,
    p_account_email: email,
    p_refresh_token: tokens.refresh_token,
    p_scopes: [calendarScope],
    p_primary_calendar_id: email,
  });
  if (saveError) throw saveError;
  return { id, email, slug, name };
}

async function removeHost(id: string) {
  await admin().from("bookings").delete().eq("host_id", id);
  await admin().rpc("google_connection_delete", { p_user_id: id });
  await admin().from("profiles").delete().eq("id", id);
  await admin().auth.admin.deleteUser(id);
}

const fakeEvents = async (calendar: string) =>
  (await fetch(`${googleFakeUrl}/control/events?calendar=${encodeURIComponent(calendar)}`).then((r) => r.json())).items as Record<string, unknown>[];
const liveEvents = async (calendar: string) => (await fakeEvents(calendar)).filter((e) => e.status !== "cancelled");
const setBusy = (calendar: string, blocks: { start: string; end: string }[]) =>
  fetch(`${googleFakeUrl}/control/busy?calendar=${encodeURIComponent(calendar)}`, { method: "POST", body: JSON.stringify(blocks) });

const bookingsOf = async (hostId: string) =>
  (await admin().from("bookings").select("id, host_id, starts_at, ends_at, booked_via, invitee_email, meet_url, google_event_id, state").eq("host_id", hostId)).data!;

// Calendar days and wall-clock times in Berlin.
const berlinDay = (at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(at);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const isoWeekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay() || 7;
function berlin(day: string, hour: number, minute = 0): string {
  for (const offset of [1, 2]) {
    const at = new Date(Date.parse(`${day}T00:00:00Z`) + ((hour - offset) * 60 + minute) * 60_000);
    const clock = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
    if (berlinDay(at) === day && clock === `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`) return at.toISOString();
  }
  throw new Error(`${day} ${hour}:${minute} does not exist in ${zone}`);
}
// The first day at least `after` days ahead (past the 24 h minimum notice) with the given ISO weekdays.
function nextDay(weekdays: number[], after = 2) {
  let day = addDays(berlinDay(new Date()), after);
  while (!weekdays.includes(isoWeekday(day))) day = addDays(day, 1);
  return day;
}
const dayLabel = (day: string) => new Intl.DateTimeFormat("en", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(new Date(`${day}T12:00:00Z`));

// Opens the day in the calendar, moving through months as needed, and returns the day's group of times.
async function openDay(page: Page, day: string) {
  const button = page.getByRole("button", { name: dayLabel(day), exact: true });
  for (let i = 0; i < 3 && !(await button.isVisible()); i++) await page.getByRole("button", { name: "Next month" }).click();
  await button.click();
  return page.getByRole("group", { name: `Free times on ${dayLabel(day)}` });
}

// The bot check wants more than three seconds between page load and submit.
async function fillDetails(page: Page, name: string, email: string) {
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.waitForTimeout(3100);
}

async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function newPage(browser: Browser) {
  const context = await browser.newContext({ timezoneId: zone, locale: "en-US" });
  return context.newPage();
}

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

test("unknown member pages and confirmation tokens show the 404 page", async ({ page }) => {
  await page.goto(`/nobody-${randomUUID().slice(0, 8)}`);
  await expect(page.getByText("This page could not be found.")).toBeVisible();
  await page.goto(`/confirmed/${"A".repeat(43)}`);
  await expect(page.getByText("This page could not be found.")).toBeVisible();
  await page.goto("/confirmed/not-a-token");
  await expect(page.getByText("This page could not be found.")).toBeVisible();
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
