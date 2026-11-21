import { randomUUID } from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { bookingsOf, fakeEvents, fillDetails, liveEvents, newHost, newPage, nextDay, noSideScroll, openDay, removeHost } from "./booking-helpers";
import { baseURL, googleFakeUrl } from "./env";
import { admin, adminEmail, signInAs } from "./session";
import { newWidget, removeWidget } from "./widget-helpers";

// Deactivating a member with a successor. Every test has its own departing member and successor, each with a fake
// calendar of their own, and the seeded admin as actor; the website default is left alone (tests/db/team.test.ts covers it).

type Host = Awaited<ReturnType<typeof newHost>>;

async function bookWith(browser: Browser, host: Host) {
  const page = await newPage(browser);
  try {
    await page.goto(`/${host.slug}`);
    await (await openDay(page, nextDay([1, 2, 3, 4, 5]))).getByRole("button", { name: "9:00 AM" }).click();
    await fillDetails(page, "Robin Invitee", `invitee-${randomUUID()}@example.com`);
    await page.getByRole("button", { name: "Book this time" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your booking is confirmed.");
  } finally {
    await page.context().close();
  }
  const [booking] = await bookingsOf(host.id);
  return booking;
}

async function deactivateWith(page: Page, leaving: Host, successor: Host) {
  const form = page.getByRole("region", { name: "Deactivate a member" });
  await form.getByLabel("Member", { exact: true }).selectOption({ label: leaving.name });
  await form.getByLabel("Takes over").selectOption({ label: successor.name });
  await form.getByRole("button", { name: "Deactivate and hand over" }).click();
  return form;
}

const unique = (name: string) => `${name} ${randomUUID().slice(0, 8)}`;
// Inserts an event straight into a fake calendar, as the member (the fake takes "fake-access-<email>" tokens).
const addEvent = async (calendar: string, body: Record<string, unknown>) =>
  (
    await fetch(`${googleFakeUrl}/calendar/v3/calendars/${encodeURIComponent(calendar)}/events`, {
      method: "POST",
      headers: { authorization: `Bearer fake-access-${calendar}`, "content-type": "application/json" },
      body: JSON.stringify({ summary: "Other", ...body }),
    }).then((r) => r.json())
  ).id as string;
const granted = async (email: string) => (await fetch(`${googleFakeUrl}/control/granted?email=${encodeURIComponent(email)}`).then((r) => r.json())).scopes as string[];

test("an admin deactivates a member: the booking gets a new event at the successor, the widget moves, the member is out; reactivating gives nothing back", async ({
  page,
  context,
  browser,
}) => {
  const leaving = await newHost({ name: unique("Leaving") });
  const successor = await newHost({ name: unique("Successor"), meetAuto: false });
  const widget = await newWidget([leaving.id]);
  try {
    const before = await bookWith(browser, leaving);
    expect(before.meet_url).toBeTruthy();
    // An event a booking left behind (its booking was never saved), and one of the member's own.
    const at = (hours: number) => ({ dateTime: new Date(Date.parse(before.starts_at) + hours * 3_600_000).toISOString(), timeZone: "UTC" });
    const orphan = await addEvent(leaving.email, { start: at(2), end: at(3), extendedProperties: { private: { booking_id: randomUUID() } } });
    const own = await addEvent(leaving.email, { start: at(4), end: at(5) });

    await signInAs(context, baseURL, adminEmail);
    await page.goto("/app/team");
    const form = await deactivateWith(page, leaving, successor);
    await expect(form.getByRole("status")).toHaveText(`${leaving.name} is deactivated. 1 upcoming booking moved to ${successor.name}.`);
    await expect(page.getByRole("listitem", { name: leaving.name, exact: true }).getByText("Deactivated")).toBeVisible();

    // Same booking, new host and a fresh event in the successor's calendar, with a video call because it had one.
    const [after] = await bookingsOf(successor.id);
    expect(after).toMatchObject({ id: before.id, state: "booked", starts_at: before.starts_at });
    expect(after.google_event_id).not.toBe(before.google_event_id);
    const [event, ...others] = await liveEvents(successor.email);
    expect(others).toEqual([]);
    expect(event).toMatchObject({
      id: after.google_event_id,
      hangoutLink: after.meet_url,
      attendees: [{ email: before.invitee_email, displayName: "Robin Invitee" }],
      query: { sendUpdates: "all" },
    });
    expect(String(event.summary)).toContain(successor.name);
    expect(after.meet_url).not.toBe(before.meet_url);

    // The old event is cancelled at Google (the invitee hears of it) and the member's Google grant is gone.
    const old = (await fakeEvents(leaving.email)).find((e) => e.id === before.google_event_id);
    expect(old).toMatchObject({ status: "cancelled", deleteQuery: { sendUpdates: "all" } });
    const left = await fakeEvents(leaving.email);
    expect(left.find((e) => e.id === orphan)).toMatchObject({ status: "cancelled", deleteQuery: { sendUpdates: "all" } });
    expect(left.find((e) => e.id === own)).toMatchObject({ status: "confirmed" });
    expect((await admin().rpc("google_refresh_token", { p_user_id: leaving.id })).data).toBeNull();
    expect(await granted(leaving.email)).toEqual([]);

    const { data: hosts } = await admin().from("booking_widget_hosts").select("user_id").eq("widget_id", widget);
    expect(hosts).toEqual([{ user_id: successor.id }]);
    const { data: outbox } = await admin().from("booking_outbox").select("type").eq("booking_id", before.id).order("created_at");
    expect(outbox!.map((row) => row.type)).toEqual(["booking.created", "booking.host_changed"]);

    // The link in the new invitation opens the booking.
    const link = String(event.description).match(/https?:\/\/\S+\/confirmed\/[\w-]+/)![0];
    const invitee = await newPage(browser);
    try {
      await invitee.goto(new URL(link).pathname);
      await expect(invitee.getByRole("heading", { level: 1 })).toHaveText("Your booking is confirmed.");
      await expect(invitee.getByText(successor.name)).toBeVisible();
      // The member's booking page is gone (the status stays 200 once the page streams; the 404 page is what counts).
      await invitee.goto(`/${leaving.slug}`);
      await expect(invitee.getByRole("heading", { level: 1 })).toHaveText("Page not found");
    } finally {
      await invitee.context().close();
    }

    // The member can no longer get in.
    const theirs = await browser.newContext();
    try {
      await signInAs(theirs, baseURL, leaving.email);
      const own = await theirs.newPage();
      await own.goto("/app");
      await expect(own).toHaveURL(/\/login\?error=no-access$/);
    } finally {
      await theirs.close();
    }

    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await noSideScroll(page);
    }

    // Reactivated, they are back without bookings, widgets or calendar.
    await page.getByRole("listitem", { name: leaving.name, exact: true }).getByRole("button", { name: "Reactivate" }).click();
    await expect(page.getByRole("listitem", { name: leaving.name, exact: true }).getByRole("button", { name: "Make admin" })).toBeVisible();
    expect((await admin().from("profiles").select("active").eq("id", leaving.id).single()).data).toEqual({ active: true });
    expect(await bookingsOf(leaving.id)).toEqual([]);
    expect((await admin().from("calendar_connections").select("user_id").eq("user_id", leaving.id)).data).toEqual([]);
    expect((await admin().from("booking_widget_hosts").select("user_id").eq("widget_id", widget)).data).toEqual([{ user_id: successor.id }]);
  } finally {
    await removeWidget(widget);
    await removeHost(leaving.id);
    await removeHost(successor.id);
  }
});

test("when Google fails in the middle nothing changes and no new event is left behind; a retry then works", async ({ page, context, browser }) => {
  const leaving = await newHost({ name: unique("Leaving") });
  const successor = await newHost({ name: unique("Successor") });
  try {
    const before = await bookWith(browser, leaving);
    await signInAs(context, baseURL, adminEmail);
    await page.goto("/app/team");

    // Google creates the event but the answer is lost: the app still knows the id and deletes it.
    await fetch(`${googleFakeUrl}/control/lose-insert?calendar=${encodeURIComponent(successor.email)}&count=1`, { method: "POST" });
    const form = await deactivateWith(page, leaving, successor);
    await expect(form.getByRole("alert")).toHaveText("Google did not accept the new events. Nothing was changed.");
    expect(await liveEvents(successor.email)).toEqual([]);
    const [withdrawn] = await fakeEvents(successor.email);
    expect(withdrawn).toMatchObject({ status: "cancelled", deleteQuery: { sendUpdates: "all" } });

    const { data: unchanged } = await admin().from("bookings").select("host_id, google_event_id, google_change_until").eq("id", before.id).single();
    expect(unchanged).toEqual({ host_id: leaving.id, google_event_id: before.google_event_id, google_change_until: null });
    expect((await admin().from("booking_tokens").select("token_hash").eq("booking_id", before.id)).data).toEqual([]);
    expect((await admin().from("profiles").select("active").eq("id", leaving.id).single()).data).toEqual({ active: true });
    expect((await liveEvents(leaving.email)).map((e) => e.id)).toEqual([before.google_event_id]);
    expect(await granted(leaving.email)).not.toEqual([]);

    // A fresh event id per attempt, so Google does not refuse the retry as a repeat of the withdrawn event.
    await form.getByRole("button", { name: "Deactivate and hand over" }).click();
    await expect(form.getByRole("status")).toHaveText(`${leaving.name} is deactivated. 1 upcoming booking moved to ${successor.name}.`);
    const [moved] = await liveEvents(successor.email);
    expect(moved.id).not.toBe(withdrawn.id);
    expect((await admin().from("bookings").select("host_id, google_event_id").eq("id", before.id).single()).data).toEqual({ host_id: successor.id, google_event_id: moved.id });
  } finally {
    await removeHost(leaving.id);
    await removeHost(successor.id);
  }
});

test("a successor without a calendar is refused before anything happens", async ({ page, context, browser }) => {
  const leaving = await newHost({ name: unique("Leaving") });
  const successor = await newHost({ name: unique("Successor") });
  try {
    const before = await bookWith(browser, leaving);
    await admin().rpc("google_connection_delete", { p_user_id: successor.id });
    await signInAs(context, baseURL, adminEmail);
    await page.goto("/app/team");
    const form = await deactivateWith(page, leaving, successor);
    await expect(form.getByRole("alert")).toHaveText(`${successor.name} must connect Google Calendar first.`);
    expect((await admin().from("bookings").select("host_id, google_change_until").eq("id", before.id).single()).data).toEqual({ host_id: leaving.id, google_change_until: null });
    expect(await fakeEvents(successor.email)).toEqual([]);
  } finally {
    await removeHost(leaving.id);
    await removeHost(successor.id);
  }
});
