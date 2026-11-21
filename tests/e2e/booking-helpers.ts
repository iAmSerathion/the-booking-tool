import { randomUUID } from "node:crypto";
import { type Browser, expect, type Page } from "@playwright/test";
import { googleFakeUrl } from "./env";
import { admin } from "./session";

// Shared by the booking and change specs: hosts with their own fake calendars (the primary calendar id is the host's
// email), the fake's events, Berlin days and times, and the booking page steps.

const calendarScope = "https://www.googleapis.com/auth/calendar";
export const zone = "Europe/Berlin";

export type Window = { weekday: number; start_time: string; end_time: string };

export async function newHost({ name = "Booking Host", meetAuto = true, windows }: { name?: string; meetAuto?: boolean; windows?: Window[] } = {}) {
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

export async function removeHost(id: string) {
  await admin().from("bookings").delete().eq("host_id", id);
  await admin().from("booking_links").delete().eq("host_id", id);
  await admin().rpc("google_connection_delete", { p_user_id: id });
  await admin().from("profiles").delete().eq("id", id);
  await admin().auth.admin.deleteUser(id);
}

export const fakeEvents = async (calendar: string) =>
  (await fetch(`${googleFakeUrl}/control/events?calendar=${encodeURIComponent(calendar)}`).then((r) => r.json())).items as Record<string, unknown>[];
export const liveEvents = async (calendar: string) => (await fakeEvents(calendar)).filter((e) => e.status !== "cancelled");
export const setBusy = (calendar: string, blocks: { start: string; end: string }[]) =>
  fetch(`${googleFakeUrl}/control/busy?calendar=${encodeURIComponent(calendar)}`, { method: "POST", body: JSON.stringify(blocks) });

export const bookingsOf = async (hostId: string) =>
  (await admin().from("bookings").select("id, host_id, starts_at, ends_at, booked_via, invitee_email, meet_url, google_event_id, state").eq("host_id", hostId)).data!;

// Calendar days and wall-clock times in Berlin.
export const berlinDay = (at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(at);
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const isoWeekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay() || 7;
export function berlin(day: string, hour: number, minute = 0): string {
  for (const offset of [1, 2]) {
    const at = new Date(Date.parse(`${day}T00:00:00Z`) + ((hour - offset) * 60 + minute) * 60_000);
    const clock = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
    if (berlinDay(at) === day && clock === `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`) return at.toISOString();
  }
  throw new Error(`${day} ${hour}:${minute} does not exist in ${zone}`);
}
// The first day at least `after` days ahead (past the 24 h minimum notice) with the given ISO weekdays.
export function nextDay(weekdays: number[], after = 2) {
  let day = addDays(berlinDay(new Date()), after);
  while (!weekdays.includes(isoWeekday(day))) day = addDays(day, 1);
  return day;
}
export const dayLabel = (day: string) => new Intl.DateTimeFormat("en", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(new Date(`${day}T12:00:00Z`));

// Opens the day in the calendar, moving through months as needed, and returns the day's group of times.
export async function openDay(page: Page, day: string) {
  const button = page.getByRole("button", { name: dayLabel(day), exact: true });
  for (let i = 0; i < 3 && !(await button.isVisible()); i++) await page.getByRole("button", { name: "Next month" }).click();
  await button.click();
  return page.getByRole("group", { name: `Free times on ${dayLabel(day)}` });
}

// The bot check wants more than three seconds between page load and submit.
export async function fillDetails(page: Page, name: string, email: string) {
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.waitForTimeout(3100);
}

export async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

export async function newPage(browser: Browser) {
  const context = await browser.newContext({ timezoneId: zone, locale: "en-US" });
  return context.newPage();
}

