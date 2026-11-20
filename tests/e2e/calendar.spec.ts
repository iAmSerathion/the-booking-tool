import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { googleFakeUrl } from "./env";
import { admin, signInAs } from "./session";

// Connecting Google Calendar through the fake (tests/e2e/google-fake.mjs). Each test uses its own member, so the fake's
// per-email state and the database rows never collide with parallel tests.

const calendarScope = "https://www.googleapis.com/auth/calendar";
const holidays = "en.usa#holiday@group.v.calendar.google.com";

async function newMember() {
  const email = `calendar-${randomUUID()}@example.com`;
  const { data, error } = await admin().auth.admin.createUser({ email, email_confirm: true });
  if (error) throw error;
  const { error: insertError } = await admin().from("profiles").insert({ id: data.user.id, name: "Calendar Member", email });
  if (insertError) throw insertError;
  return { email, id: data.user.id };
}

async function removeMember(id: string) {
  await admin().rpc("google_connection_delete", { p_user_id: id });
  await admin().from("profiles").delete().eq("id", id);
  await admin().auth.admin.deleteUser(id);
}

const connection = async (id: string) =>
  (await admin().from("calendar_connections").select("account_email, scopes, status, primary_calendar_id, busy_calendar_ids, token_refreshed_at").eq("user_id", id).maybeSingle()).data;

const refreshToken = async (id: string) => (await admin().rpc("google_refresh_token", { p_user_id: id })).data as string | null;

const fake = (path: string, method = "POST") => fetch(`${googleFakeUrl}${path}`, { method }).then((r) => r.json());

async function connect(page: Page) {
  await page.goto("/app/settings");
  await page.getByRole("link", { name: "Connect Google Calendar" }).click();
  await expect(page).toHaveURL("/app/settings");
}

test("a member connects their calendar, picks busy calendars and disconnects", async ({ page, context, baseURL }) => {
  const member = await newMember();
  try {
    await signInAs(context, baseURL!, member.email);
    await connect(page);
    const calendar = page.getByRole("region", { name: "Google Calendar" });
    await expect(calendar.getByText(`Connected with ${member.email}`)).toBeVisible();
    await expect(calendar.getByRole("alert")).toHaveCount(0);

    expect(await refreshToken(member.id)).toMatch(/^fake-refresh-/);
    const row = await connection(member.id);
    expect(row).toMatchObject({ account_email: member.email, scopes: [calendarScope], status: "ok", primary_calendar_id: member.email });
    // The settings page refreshed the access token on load.
    expect(row!.token_refreshed_at).not.toBeNull();

    // The calendar list comes from Google; the primary calendar always counts as busy.
    const primary = calendar.getByRole("checkbox", { name: `${member.email} (primary calendar)` });
    await expect(primary).toBeChecked();
    await expect(primary).toBeDisabled();
    await calendar.getByRole("checkbox", { name: "Holidays" }).check();
    await calendar.getByRole("button", { name: "Save busy calendars" }).click();
    await expect.poll(async () => (await connection(member.id))?.busy_calendar_ids).toEqual([member.email, holidays]);
    await page.reload();
    await expect(calendar.getByRole("checkbox", { name: "Holidays" })).toBeChecked();
    await expect(calendar.getByRole("checkbox", { name: "Team" })).not.toBeChecked();

    await calendar.getByRole("button", { name: "Disconnect" }).click();
    await expect(calendar.getByRole("link", { name: "Connect Google Calendar" })).toBeVisible();
    expect(await refreshToken(member.id)).toBeNull();
    expect(await connection(member.id)).toBeNull();
    // The grant was given back to Google too.
    expect(await fake(`/control/granted?email=${encodeURIComponent(member.email)}`, "GET")).toEqual({ scopes: [] });
  } finally {
    await removeMember(member.id);
  }
});

test("a grant Google no longer accepts shows reconnect needed, and reconnecting fixes it", async ({ page, context, baseURL }) => {
  const member = await newMember();
  try {
    await signInAs(context, baseURL!, member.email);
    await connect(page);
    const calendar = page.getByRole("region", { name: "Google Calendar" });
    await expect(calendar.getByText(`Connected with ${member.email}`)).toBeVisible();

    await fake(`/control/invalidate?email=${encodeURIComponent(member.email)}`);
    await page.reload();
    await expect(calendar.getByText("Reconnect needed:")).toBeVisible();
    await expect(calendar.getByText("Your calendars cannot be loaded from Google right now.")).toBeVisible();
    expect((await connection(member.id))?.status).toBe("needs_reconnect");

    await calendar.getByRole("link", { name: "Reconnect Google Calendar" }).click();
    await expect(calendar.getByText(`Connected with ${member.email}`)).toBeVisible();
    expect((await connection(member.id))?.status).toBe("ok");
  } finally {
    await removeMember(member.id);
  }
});

test("without REQUIRE_SAME_GOOGLE_EMAIL a different Google account may be connected", async ({ page, context, baseURL }) => {
  const member = await newMember();
  const other = `other-${randomUUID()}@example.com`;
  try {
    await signInAs(context, baseURL!, member.email);
    await fake(`/control/other-account?hint=${encodeURIComponent(member.email)}&email=${encodeURIComponent(other)}`);
    await connect(page);
    await expect(page.getByText(`Connected with ${other}`)).toBeVisible();
    expect(await connection(member.id)).toMatchObject({ account_email: other, primary_calendar_id: other });
  } finally {
    await removeMember(member.id);
  }
});

test("a callback without the matching state cookie is refused", async ({ page, context, baseURL }) => {
  const member = await newMember();
  try {
    await signInAs(context, baseURL!, member.email);
    // A code and state from someone else's flow, e.g. sent as a link.
    await page.goto("/api/google/callback?code=forged&state=forged");
    await expect(page).toHaveURL("/app/settings?google=error");
    await expect(page.getByRole("region", { name: "Google Calendar" }).getByRole("alert")).toHaveText(
      "Connecting Google Calendar failed. Please try again.",
    );
    expect(await connection(member.id)).toBeNull();
    // Unknown notice keys show nothing.
    await page.goto("/app/settings?google=<b>hi</b>");
    await expect(page.getByRole("region", { name: "Google Calendar" }).getByRole("alert")).toHaveCount(0);
  } finally {
    await removeMember(member.id);
  }
});

test("connect and callback send signed-out visitors to the login", async ({ page }) => {
  await page.goto("/api/google/connect");
  await expect(page).toHaveURL("/login");
  await page.goto("/api/google/callback?code=x&state=y");
  await expect(page).toHaveURL("/login");
});
