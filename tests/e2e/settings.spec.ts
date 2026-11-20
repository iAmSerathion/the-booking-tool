import { expect, test } from "@playwright/test";
import { admin, adminEmail, hostEmail, signInAs, userClient } from "./session";

// The M3 acceptance test: a seeded member signs in, connects Google Calendar through the fake, picks busy calendars,
// saves availability and booking rules, and finds everything again after a reload. The seeded rows are restored after.

const holidays = "en.usa#holiday@group.v.calendar.google.com";
const ruleColumns = "timezone, buffer_minutes, min_notice_hours, max_bookings_per_day, meet_auto";

async function userId(email: string) {
  const { data, error } = await admin().from("profiles").select("id").eq("email", email).single();
  if (error) throw error;
  return data.id as string;
}

async function snapshot(id: string) {
  const [profile, windows] = await Promise.all([
    admin().from("profiles").select(ruleColumns).eq("id", id).single(),
    admin().from("availability_windows").select("user_id, weekday, start_time, end_time").eq("user_id", id),
  ]);
  return async () => {
    await admin().rpc("google_connection_delete", { p_user_id: id });
    await admin().from("profiles").update(profile.data!).eq("id", id);
    await admin().from("availability_windows").delete().eq("user_id", id);
    await admin().from("availability_windows").insert(windows.data!);
  };
}

const windowsOf = async (id: string, weekday: number) =>
  (await admin().from("availability_windows").select("start_time, end_time").eq("user_id", id).eq("weekday", weekday).order("start_time")).data;

test("a member connects the calendar, saves busy calendars, availability and rules, and they persist", async ({ page, context, baseURL }) => {
  const id = await userId(hostEmail);
  const restore = await snapshot(id);
  try {
    await signInAs(context, baseURL!, hostEmail);
    await page.goto("/app/settings");
    // The seeded host has a slug; the link is built from APP_URL.
    await expect(page.getByRole("region", { name: "Booking link" }).getByRole("link")).toHaveText(`${baseURL}/demo-host`);

    const calendar = page.getByRole("region", { name: "Google Calendar" });
    await calendar.getByRole("link", { name: "Connect Google Calendar" }).click();
    await expect(page).toHaveURL("/app/settings");
    await expect(calendar.getByText(`Connected with ${hostEmail}`)).toBeVisible();

    await calendar.getByRole("checkbox", { name: "Holidays" }).check();
    await calendar.getByRole("button", { name: "Save busy calendars" }).click();
    await expect(calendar.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    expect((await admin().from("calendar_connections").select("busy_calendar_ids").eq("user_id", id).single()).data?.busy_calendar_ids).toEqual([
      hostEmail,
      holidays,
    ]);

    // Overlapping windows are refused inline and what was typed stays in the field.
    const availability = page.getByRole("region", { name: "Availability" });
    const saturday = availability.getByRole("textbox", { name: "Saturday" });
    await saturday.fill("10:00-12:00, 11:00-13:00");
    await availability.getByRole("button", { name: "Save availability" }).click();
    await expect(availability.getByRole("alert")).toHaveText("Saturday: 10:00-12:00 and 11:00-13:00 overlap.");
    await expect(saturday).toHaveValue("10:00-12:00, 11:00-13:00");
    expect(await windowsOf(id, 6)).toEqual([]);

    await saturday.fill("13:00-15:30, 10:00-12:00");
    await availability.getByRole("textbox", { name: "Monday" }).fill("08:00-12:00");
    await availability.getByRole("textbox", { name: "Friday" }).fill("");
    await availability.getByRole("button", { name: "Save availability" }).click();
    await expect(availability.getByRole("status")).toHaveText("Saved.");
    expect(await windowsOf(id, 6)).toEqual([
      { start_time: "10:00:00", end_time: "12:00:00" },
      { start_time: "13:00:00", end_time: "15:30:00" },
    ]);
    expect(await windowsOf(id, 1)).toEqual([{ start_time: "08:00:00", end_time: "12:00:00" }]);
    expect(await windowsOf(id, 5)).toEqual([]);

    const rules = page.getByRole("region", { name: "Booking rules" });
    await rules.getByRole("combobox", { name: "Time zone" }).selectOption("Europe/Oslo");
    await rules.getByRole("spinbutton", { name: "Buffer between bookings (minutes)" }).fill("20");
    await rules.getByRole("spinbutton", { name: "Minimum notice (hours)" }).fill("48");
    await rules.getByRole("spinbutton", { name: "Max bookings per day" }).fill("5");
    await rules.getByRole("checkbox", { name: "Add a Google Meet link to new bookings" }).uncheck();
    await rules.getByRole("button", { name: "Save booking rules" }).click();
    await expect(rules.getByRole("status")).toHaveText("Saved.");
    expect((await admin().from("profiles").select(ruleColumns).eq("id", id).single()).data).toEqual({
      timezone: "Europe/Oslo",
      buffer_minutes: 20,
      min_notice_hours: 48,
      max_bookings_per_day: 5,
      meet_auto: false,
    });

    await page.reload();
    await expect(calendar.getByText(`Connected with ${hostEmail}`)).toBeVisible();
    await expect(calendar.getByRole("checkbox", { name: "Holidays" })).toBeChecked();
    await expect(saturday).toHaveValue("10:00-12:00, 13:00-15:30");
    await expect(availability.getByRole("textbox", { name: "Monday" })).toHaveValue("08:00-12:00");
    await expect(availability.getByRole("textbox", { name: "Friday" })).toHaveValue("");
    await expect(availability.getByRole("textbox", { name: "Tuesday" })).toHaveValue("09:00-12:00, 14:00-17:00");
    await expect(rules.getByRole("combobox", { name: "Time zone" })).toHaveValue("Europe/Oslo");
    await expect(rules.getByRole("spinbutton", { name: "Buffer between bookings (minutes)" })).toHaveValue("20");
    await expect(rules.getByRole("spinbutton", { name: "Minimum notice (hours)" })).toHaveValue("48");
    await expect(rules.getByRole("spinbutton", { name: "Max bookings per day" })).toHaveValue("5");
    await expect(rules.getByRole("checkbox", { name: "Add a Google Meet link to new bookings" })).not.toBeChecked();
  } finally {
    await restore();
  }
});

test("a member cannot change another member's settings", async () => {
  const [hostId, adminId] = await Promise.all([userId(hostEmail), userId(adminEmail)]);
  const restore = await snapshot(adminId);
  try {
    // The other member has a connection, so a refused update is not just "no row to update".
    const { error: saveError } = await admin().rpc("google_connection_save", {
      p_user_id: adminId,
      p_account_email: adminEmail,
      p_refresh_token: "fake-refresh-rls-check",
      p_scopes: ["https://www.googleapis.com/auth/calendar"],
      p_primary_calendar_id: adminEmail,
    });
    expect(saveError).toBeNull();
    const before = await snapshotRows(adminId);
    const host = await userClient(hostEmail);

    const profile = await host.from("profiles").update({ buffer_minutes: 99 }).eq("id", adminId).select("id");
    expect(profile.error).toBeNull();
    expect(profile.data).toEqual([]);

    const busy = await host.from("calendar_connections").update({ busy_calendar_ids: ["x"] }).eq("user_id", adminId).select("user_id");
    expect(busy.error).toBeNull();
    expect(busy.data).toEqual([]);

    const removed = await host.from("availability_windows").delete().eq("user_id", adminId).select("id");
    expect(removed.error).toBeNull();
    expect(removed.data).toEqual([]);

    const inserted = await host.from("availability_windows").insert({ user_id: adminId, weekday: 6, start_time: "10:00", end_time: "11:00" });
    expect(inserted.error?.code).toBe("42501");

    // Rights, slug and other columns are not the member's to change, not even on their own row.
    const own = await host.from("profiles").update({ slug: "taken-over", is_admin: true }).eq("id", hostId);
    expect(own.error?.code).toBe("42501");

    expect(await snapshotRows(adminId)).toEqual(before);
  } finally {
    await restore();
  }
});

async function snapshotRows(id: string) {
  const [profile, connection, windows] = await Promise.all([
    admin().from("profiles").select(`${ruleColumns}, slug, is_admin`).eq("id", id).single(),
    admin().from("calendar_connections").select("busy_calendar_ids").eq("user_id", id).single(),
    admin().from("availability_windows").select("weekday, start_time, end_time").eq("user_id", id).order("weekday").order("start_time"),
  ]);
  return { profile: profile.data, connection: connection.data, windows: windows.data };
}

test("the settings page fits a phone screen without sideways scrolling", async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(context, baseURL!, hostEmail);
  await page.goto("/app/settings");
  await expect(page.getByRole("heading", { name: "Availability" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
