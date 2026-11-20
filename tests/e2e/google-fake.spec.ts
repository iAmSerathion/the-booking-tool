import { expect, test } from "@playwright/test";
import { googleFakeUrl } from "./env";

// Checks the Google fake the app talks to, so app tests can trust it.
const email = "fake.check@example.com";
const redirectUri = "http://127.0.0.1:3100/api/google/callback";
const client = { client_id: "fake-client", client_secret: "fake-secret" };

test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ request }) => {
  await request.post(`${googleFakeUrl}/reset`);
});

async function consent(request: import("@playwright/test").APIRequestContext, hint = email) {
  const auth = new URL(`${googleFakeUrl}/o/oauth2/v2/auth`);
  auth.search = new URLSearchParams({ client_id: "fake-client", redirect_uri: redirectUri, login_hint: hint, state: "s1",
    scope: "openid email https://www.googleapis.com/auth/calendar" }).toString();
  const response = await request.get(auth.toString(), { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  const back = new URL(response.headers().location);
  expect(back.origin + back.pathname).toBe(redirectUri);
  expect(back.searchParams.get("state")).toBe("s1");
  return back.searchParams.get("code")!;
}

const token = (request: import("@playwright/test").APIRequestContext, form: Record<string, string>) =>
  request.post(`${googleFakeUrl}/token`, { form: { ...client, ...form } });

test("consent, token exchange, calendar list, refresh and revoke", async ({ request }) => {
  const code = await consent(request);
  const tokens = await (await token(request, { grant_type: "authorization_code", code, redirect_uri: redirectUri })).json();
  expect(tokens.refresh_token).toMatch(/^fake-refresh-fake\.check@example\.com\|/);
  expect(JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString())).toMatchObject({ email, email_verified: true });

  const list = await request.get(`${googleFakeUrl}/calendar/v3/users/me/calendarList`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  expect((await list.json()).items[0]).toMatchObject({ id: email, primary: true });

  const refreshed = await token(request, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  expect(refreshed.status()).toBe(200);

  await request.post(`${googleFakeUrl}/revoke`, { form: { token: tokens.refresh_token } });
  expect((await token(request, { grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status()).toBe(400);
});

test("rejects a mismatched redirect_uri, unknown tokens and invalidated grants", async ({ request }) => {
  const code = await consent(request);
  expect((await token(request, { grant_type: "authorization_code", code, redirect_uri: "http://127.0.0.1:1/x" })).status()).toBe(400);
  expect((await token(request, { grant_type: "refresh_token", refresh_token: "real-token" })).status()).toBe(500);

  const tokens = await (await token(request, { grant_type: "authorization_code", code, redirect_uri: redirectUri })).json();
  await request.post(`${googleFakeUrl}/control/invalidate?email=${encodeURIComponent(email)}`);
  const refreshed = await token(request, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  expect(await refreshed.json()).toEqual({ error: "invalid_grant" });
});

test("other-account picks a different Google account for the next consent only", async ({ request }) => {
  await request.post(`${googleFakeUrl}/control/other-account?hint=${encodeURIComponent(email)}&email=other@example.com`);
  const exchange = async () =>
    (await (await token(request, { grant_type: "authorization_code", code: await consent(request), redirect_uri: redirectUri })).json()).refresh_token;
  expect(await exchange()).toMatch(/^fake-refresh-other@example\.com\|/);
  expect(await exchange()).toMatch(/^fake-refresh-fake\.check@example\.com\|/);
});

test("free/busy returns the busy blocks set for a calendar inside the range", async ({ request }) => {
  const block = { start: "2030-01-07T09:00:00Z", end: "2030-01-07T10:00:00Z" };
  await request.post(`${googleFakeUrl}/control/busy?calendar=${encodeURIComponent(email)}`, { data: [block] });
  const response = await request.post(`${googleFakeUrl}/calendar/v3/freeBusy`, {
    headers: { authorization: `Bearer fake-access-${email}` },
    data: { timeMin: "2030-01-07T00:00:00Z", timeMax: "2030-01-08T00:00:00Z", items: [{ id: email }, { id: "empty@example.com" }] },
  });
  expect((await response.json()).calendars).toEqual({ [email]: { busy: [block] }, "empty@example.com": { busy: [] } });
});
