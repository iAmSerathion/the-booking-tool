import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { googleFakeUrl } from "./env";

// Checks the Google fake the app talks to, so app tests can trust it.
const email = "fake.check@example.com";
const redirectUri = "http://127.0.0.1:3100/api/google/callback";
const client = { client_id: "fake-client", client_secret: "fake-secret" };

test.describe.configure({ mode: "serial" });
// No /reset here: the fake is shared with the calendar and settings tests running in parallel, and a reset would wipe
// their grants. Every test below uses this file's own emails instead.

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

test("events: insert with Meet, list, free/busy, delete, and one-shot insert failures per calendar", async ({ request }) => {
  // Unique per run: a reused fake keeps its events.
  const calendar = `events#${Date.now()}@example.com`;
  const auth = { authorization: `Bearer fake-access-${email}` };
  const events = `${googleFakeUrl}/calendar/v3/calendars/${encodeURIComponent(calendar)}/events`;
  const body = {
    summary: "Check",
    start: { dateTime: "2030-01-07T09:00:00.000Z", timeZone: "UTC" },
    end: { dateTime: "2030-01-07T09:30:00.000Z", timeZone: "UTC" },
    conferenceData: { createRequest: { requestId: "r1", conferenceSolutionKey: { type: "hangoutsMeet" } } },
  };
  expect((await request.post(events, { data: body })).status()).toBe(401);

  // Without conferenceDataVersion=1 Google ignores the conference request.
  const plain = await (await request.post(events, { headers: auth, data: body })).json();
  expect(plain.hangoutLink).toBeUndefined();
  expect(plain.conferenceData).toBeUndefined();
  const meet = await (await request.post(`${events}?conferenceDataVersion=1&sendUpdates=all`, { headers: auth, data: body })).json();
  expect(meet.hangoutLink).toMatch(/^https:\/\/meet\.google\.com\//);
  expect(meet.conferenceData.entryPoints).toEqual([{ entryPointType: "video", uri: meet.hangoutLink }]);

  const range = "timeMin=2030-01-07T00:00:00Z&timeMax=2030-01-08T00:00:00Z";
  expect((await (await request.get(`${events}?${range}`, { headers: auth })).json()).items).toHaveLength(2);
  const busy = async () =>
    (
      await (
        await request.post(`${googleFakeUrl}/calendar/v3/freeBusy`, {
          headers: auth,
          data: { timeMin: "2030-01-07T00:00:00Z", timeMax: "2030-01-08T00:00:00Z", items: [{ id: calendar }] },
        })
      ).json()
    ).calendars[calendar].busy;
  expect(await busy()).toEqual([
    { start: body.start.dateTime, end: body.end.dateTime },
    { start: body.start.dateTime, end: body.end.dateTime },
  ]);

  const remove = (id: string) => request.delete(`${events}/${id}?sendUpdates=none`, { headers: auth });
  expect((await remove(plain.id)).status()).toBe(204);
  expect((await remove(meet.id)).status()).toBe(204);
  expect((await remove(meet.id)).status()).toBe(410);
  expect(await busy()).toEqual([]);
  const control = (await (await request.get(`${googleFakeUrl}/control/events?calendar=${encodeURIComponent(calendar)}`)).json()).items;
  expect(control.map((e: { status: string; deleteQuery: unknown }) => [e.status, e.deleteQuery])).toEqual([
    ["cancelled", { sendUpdates: "none" }],
    ["cancelled", { sendUpdates: "none" }],
  ]);

  await request.post(`${googleFakeUrl}/control/fail-insert?calendar=${encodeURIComponent(calendar)}&count=1`);
  expect((await request.post(events, { headers: auth, data: body })).status()).toBe(503);
  expect((await request.post(events, { headers: auth, data: body })).status()).toBe(200);
});

test("events: patch moves an event in free/busy, keeps every patch with its query, and fails once per calendar on request", async ({ request }) => {
  const calendar = `patch#${Date.now()}@example.com`;
  const auth = { authorization: `Bearer fake-access-${email}` };
  const events = `${googleFakeUrl}/calendar/v3/calendars/${encodeURIComponent(calendar)}/events`;
  const at = (hour: number) => ({ dateTime: `2030-01-08T${String(hour).padStart(2, "0")}:00:00.000Z`, timeZone: "UTC" });
  const created = await (await request.post(events, { headers: auth, data: { summary: "Move me", start: at(9), end: at(10) } })).json();
  const patch = (id: string) => request.patch(`${events}/${id}?sendUpdates=all`, { headers: auth, data: { start: at(13), end: at(14) } });

  await request.post(`${googleFakeUrl}/control/fail-patch?calendar=${encodeURIComponent(calendar)}&count=1`);
  expect((await patch(created.id)).status()).toBe(503);
  const moved = await (await patch(created.id)).json();
  expect(moved).toMatchObject({ summary: "Move me", start: at(13), end: at(14), patches: [{ body: { start: at(13), end: at(14) }, query: { sendUpdates: "all" } }] });
  const busy = await (
    await request.post(`${googleFakeUrl}/calendar/v3/freeBusy`, {
      headers: auth,
      data: { timeMin: "2030-01-08T00:00:00Z", timeMax: "2030-01-09T00:00:00Z", items: [{ id: calendar }] },
    })
  ).json();
  expect(busy.calendars[calendar].busy).toEqual([{ start: at(13).dateTime, end: at(14).dateTime }]);

  expect((await patch("missing")).status()).toBe(404);
  await request.delete(`${events}/${created.id}`, { headers: auth });
  expect((await patch(created.id)).status()).toBe(404);
});

test("sync and channels: watch notifies a loopback address of every change, a sync token lists what changed, a 410 once on request, stop", async ({ request }) => {
  const calendar = `sync#${Date.now()}@example.com`;
  const auth = { authorization: `Bearer fake-access-${email}` };
  const events = `${googleFakeUrl}/calendar/v3/calendars/${encodeURIComponent(calendar)}/events`;
  const at = (hour: number) => ({ dateTime: `2030-01-09T${String(hour).padStart(2, "0")}:00:00.000Z`, timeZone: "UTC" });

  // A stand-in for the app's webhook route.
  const notifications: Record<string, string | undefined>[] = [];
  const receiver = createServer((req, res) => {
    notifications.push({ id: req.headers["x-goog-channel-id"] as string, token: req.headers["x-goog-channel-token"] as string, state: req.headers["x-goog-resource-state"] as string });
    res.end();
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
  try {
    const watch = (data: Record<string, unknown>) => request.post(`${events}/watch`, { headers: auth, data });
    expect((await watch({ id: "c0", token: "t0", type: "web_hook", address: "https://hooks.example.com/x" })).status()).toBe(400);
    const channel = await (await watch({ id: `c-${calendar}`, token: "secret", type: "web_hook", address, params: { ttl: "60" } })).json();
    expect(channel.resourceId).toBeTruthy();
    expect(Number(channel.expiration)).toBeGreaterThan(Date.now());
    await expect.poll(() => notifications).toEqual([{ id: `c-${calendar}`, token: "secret", state: "sync" }]);

    const full = await (await request.get(`${events}?timeMin=2030-01-01T00:00:00Z&showDeleted=true`, { headers: auth })).json();
    expect(full.items).toEqual([]);
    const created = await (await request.post(events, { headers: auth, data: { summary: "Sync me", start: at(9), end: at(10) } })).json();
    await request.post(`${googleFakeUrl}/control/calendar?calendar=${encodeURIComponent(calendar)}&event=${created.id}&action=delete`);
    await expect.poll(() => notifications.map((n) => n.state)).toEqual(["sync", "exists", "exists"]);

    const changes = await (await request.get(`${events}?syncToken=${full.nextSyncToken}&showDeleted=true`, { headers: auth })).json();
    expect(changes.items).toEqual([{ id: created.id, status: "cancelled" }]);
    const none = await (await request.get(`${events}?syncToken=${changes.nextSyncToken}`, { headers: auth })).json();
    expect(none.items).toEqual([]);

    await request.post(`${googleFakeUrl}/control/sync-gone?calendar=${encodeURIComponent(calendar)}`);
    expect((await request.get(`${events}?syncToken=${changes.nextSyncToken}`, { headers: auth })).status()).toBe(410);
    expect((await request.get(`${events}?syncToken=${changes.nextSyncToken}`, { headers: auth })).status()).toBe(200);

    const listed = async () => (await (await request.get(`${googleFakeUrl}/control/channels?calendar=${encodeURIComponent(calendar)}`)).json()).items;
    expect(await listed()).toHaveLength(1);
    const stop = (resourceId: string) => request.post(`${googleFakeUrl}/calendar/v3/channels/stop`, { headers: auth, data: { id: `c-${calendar}`, resourceId } });
    expect((await stop("wrong")).status()).toBe(404);
    expect((await stop(channel.resourceId)).status()).toBe(204);
    expect(await listed()).toEqual([]);
  } finally {
    receiver.close();
  }
});
