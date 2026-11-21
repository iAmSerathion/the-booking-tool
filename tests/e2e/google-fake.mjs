// Test-only stand-in for the Google endpoints the app calls: OAuth consent, token, revoke, calendar list, free/busy and
// events (insert with Meet, move, delete, list), incremental sync (syncToken, a 410 on request) and push channels (watch,
// stop) that notify the app on every change, as Google does, the app's own changes included.
// Playwright starts it (playwright.config.ts); the app uses it only when GOOGLE_FAKE_URL points at a loopback host.
// It listens on 127.0.0.1 only. Never point a real instance at it.
//
// Not covered: the Supabase login with Google. GoTrue's Google provider always talks to accounts.google.com (it ignores
// GOTRUE_EXTERNAL_GOOGLE_URL), so e2e tests sign in with magic-link sessions (tests/e2e/session.ts) instead.
//
// Unknown refresh tokens get a 500, not invalid_grant, so a real connection is never marked "needs reconnect" if a dev
// instance is ever pointed at the fake.
import { createServer } from "node:http";

const port = Number(process.env.GOOGLE_FAKE_PORT ?? 3999);

let granted, invalid, otherAccount, busy, events, failInsert, loseInsert, failPatch, losePatch, counter, deny, onlyScope, failExchange, channels, syncGone, seq;
const reset = () => {
  granted = new Map(); // email -> granted scopes
  invalid = new Set(); // emails whose refresh tokens Google no longer accepts
  otherAccount = new Map(); // login_hint -> email the next consent signs in with instead
  busy = new Map(); // calendar id -> [{ start, end }] ISO instants
  events = new Map(); // calendar id -> Map(event id -> { id, status, query, deleteQuery?, ...body })
  failInsert = new Map(); // calendar id -> how many of the next event inserts fail with a 503
  loseInsert = new Map(); // calendar id -> how many of the next event inserts are created but answered with a 503
  failPatch = new Map(); // calendar id -> how many of the next event patches fail with a 503
  losePatch = new Map(); // calendar id -> how many of the next event patches are applied but answered with a 503
  deny = new Set(); // login_hints whose next consent is cancelled
  onlyScope = new Map(); // login_hint -> the only scope the next consent grants
  failExchange = new Set(); // emails whose next code exchange fails
  channels = new Map(); // channel id -> { id, calendarId, address, token, resourceId, expiration }
  syncGone = new Set(); // calendar ids whose next list with a sync token gets a 410
  counter = 0;
  seq = 0; // bumped on every event change; a sync token is "seq:<n>", and lists what changed after n
};
reset();

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const read = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = (value) => {
  try {
    return JSON.parse(Buffer.from(value ?? "", "base64url").toString("utf8"));
  } catch {
    return null;
  }
};

// Unsigned like a token fetched straight from the token endpoint; the app reads it without verifying (OIDC 3.1.3.7).
const idToken = (email) => `${encode({ alg: "none" })}.${encode({ email, email_verified: true, hd: email.split("@")[1] })}.`;

const emailOf = (token, prefix) => (token?.startsWith(prefix) ? token.slice(prefix.length).split("|")[0] : null);
const bearerEmail = (req) => emailOf(req.headers.authorization?.replace(/^Bearer /, ""), "fake-access-");

const calendarEvents = (calendarId) => {
  if (!events.has(calendarId)) events.set(calendarId, new Map());
  return events.get(calendarId);
};
const liveEvents = (calendarId, from, to) =>
  [...calendarEvents(calendarId).values()].filter(
    (e) => e.status !== "cancelled" && Date.parse(e.start.dateTime) < to && Date.parse(e.end.dateTime) > from,
  );
// Fire and forget, like Google: header-only POSTs to the address the channel was created with (loopback only, see watch).
const notify = (channel, state) =>
  fetch(channel.address, {
    method: "POST",
    headers: {
      "x-goog-channel-id": channel.id,
      "x-goog-channel-token": channel.token,
      "x-goog-resource-id": channel.resourceId,
      "x-goog-resource-state": state,
      "x-goog-message-number": String(++counter),
    },
  }).catch(() => {});
// Stores the event with a new seq and notifies every channel on its calendar.
const changed = (calendarId, event) => {
  event.seq = ++seq;
  calendarEvents(calendarId).set(event.id, event);
  for (const channel of channels.values()) if (channel.calendarId === calendarId) notify(channel, "exists");
  return event;
};
// A deleted event comes back from a sync with its id and status only.
const asGoogle = (event) => (event.status === "cancelled" ? { id: event.id, status: "cancelled" } : event);
const loopback = (address) => {
  try {
    const url = new URL(address);
    return ["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "localhost"].includes(url.hostname);
  } catch {
    return false;
  }
};

// /calendar/v3/calendars/<id>/events[/<event id>], ids URL-encoded ("#" arrives as %23).
const eventsPath = (pathname) => {
  const match = pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
  return match && { calendarId: decodeURIComponent(match[1]), eventId: match[2] && decodeURIComponent(match[2]) };
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const post = req.method === "POST";

  if (url.pathname === "/health") return json(res, 200, { ok: true });
  // Wipes every email's state. The fake is shared by all parallel workers, so tests must not call this; they use their
  // own emails instead.
  if (url.pathname === "/reset" && post) {
    reset();
    return json(res, 200, {});
  }

  // Consent: straight back to the app, as if the user clicked "Allow". The code carries what /token needs to check.
  if (url.pathname === "/o/oauth2/v2/auth") {
    const redirectUri = url.searchParams.get("redirect_uri");
    if (!url.searchParams.get("client_id") || !redirectUri) return json(res, 400, { error: "invalid_request" });
    const hint = url.searchParams.get("login_hint") ?? "";
    const email = otherAccount.get(hint) ?? hint;
    otherAccount.delete(hint);
    const back = new URL(redirectUri);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    if (deny.delete(hint)) back.searchParams.set("error", "access_denied");
    else back.searchParams.set("code", encode({ email, scope: onlyScope.get(hint) ?? url.searchParams.get("scope") ?? "", redirectUri }));
    onlyScope.delete(hint);
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }

  if (url.pathname === "/token" && post) {
    const body = new URLSearchParams(await read(req));
    if (!body.get("client_id") || !body.get("client_secret")) return json(res, 401, { error: "invalid_client" });
    if (body.get("grant_type") === "authorization_code") {
      const code = decode(body.get("code"));
      // Google rejects a token request whose redirect_uri differs from the one used for consent.
      if (!code?.email || code.redirectUri !== body.get("redirect_uri")) return json(res, 400, { error: "invalid_grant" });
      if (failExchange.delete(code.email)) return json(res, 500, { error: "backend_error" });
      const scopes = new Set([...(granted.get(code.email) ?? []), ...code.scope.split(" ").filter(Boolean)]);
      granted.set(code.email, scopes);
      invalid.delete(code.email);
      return json(res, 200, {
        access_token: `fake-access-${code.email}`,
        expires_in: 3599,
        refresh_token: `fake-refresh-${code.email}|${++counter}`,
        scope: [...scopes].join(" "),
        token_type: "Bearer",
        id_token: idToken(code.email),
      });
    }
    const email = emailOf(body.get("refresh_token"), "fake-refresh-");
    if (!email) return json(res, 500, { error: "unknown_token" });
    if (invalid.has(email) || !granted.has(email)) return json(res, 400, { error: "invalid_grant" });
    return json(res, 200, { access_token: `fake-access-${email}`, expires_in: 3599, token_type: "Bearer" });
  }

  if (url.pathname === "/revoke" && post) {
    const email = emailOf(new URLSearchParams(await read(req)).get("token"), "fake-refresh-");
    if (email) granted.delete(email);
    return json(res, 200, {});
  }

  if (url.pathname === "/calendar/v3/users/me/calendarList") {
    const email = bearerEmail(req);
    if (!email) return json(res, 401, { error: { status: "UNAUTHENTICATED" } });
    return json(res, 200, {
      items: [
        { id: email, summary: email, primary: true },
        { id: "team@group.calendar.google.com", summary: "Team" },
        // The "#" checks that calendar ids are URL-encoded wherever they end up in a path.
        { id: "en.usa#holiday@group.v.calendar.google.com", summary: "Holidays" },
      ],
    });
  }

  if (url.pathname === "/calendar/v3/freeBusy" && post) {
    if (!bearerEmail(req)) return json(res, 401, { error: { status: "UNAUTHENTICATED" } });
    const { timeMin, timeMax, items = [] } = JSON.parse(await read(req));
    const from = Date.parse(timeMin);
    const to = Date.parse(timeMax);
    // Like Google: set busy blocks plus the calendar's own (opaque) events.
    const calendars = Object.fromEntries(
      items.map(({ id }) => [
        id,
        {
          busy: [
            ...(busy.get(id) ?? []).filter((b) => Date.parse(b.start) < to && Date.parse(b.end) > from),
            ...liveEvents(id, from, to).map((e) => ({ start: e.start.dateTime, end: e.end.dateTime })),
          ],
        },
      ]),
    );
    return json(res, 200, { kind: "calendar#freeBusy", timeMin, timeMax, calendars });
  }

  const path = eventsPath(url.pathname);
  if (path) {
    if (!bearerEmail(req)) return json(res, 401, { error: { status: "UNAUTHENTICATED" } });
    const list = calendarEvents(path.calendarId);
    const query = Object.fromEntries(url.searchParams);
    if (!path.eventId && post) {
      const left = failInsert.get(path.calendarId) ?? 0;
      if (left > 0) {
        failInsert.set(path.calendarId, left - 1);
        return json(res, 503, { error: { status: "UNAVAILABLE" } });
      }
      const body = JSON.parse(await read(req));
      // Like Google: a client-chosen id is kept, and one that exists already (cancelled ones too) is a conflict.
      if (body.id && list.has(body.id)) return json(res, 409, { error: { status: "ALREADY_EXISTS" } });
      const id = body.id ?? `fake-event-${++counter}`;
      const event = { ...body, id, status: "confirmed", query };
      // Google adds a conference only with conferenceDataVersion=1; without it the create request is ignored.
      if (body.conferenceData?.createRequest && query.conferenceDataVersion === "1") {
        const uri = `https://meet.google.com/fake-${id}`;
        event.hangoutLink = uri;
        event.conferenceData = { ...body.conferenceData, entryPoints: [{ entryPointType: "video", uri }] };
      } else delete event.conferenceData;
      changed(path.calendarId, event);
      const lost = loseInsert.get(path.calendarId) ?? 0;
      if (lost > 0) {
        loseInsert.set(path.calendarId, lost - 1);
        return json(res, 503, { error: { status: "UNAVAILABLE" } });
      }
      return json(res, 200, event);
    }
    if (!path.eventId && req.method === "GET") {
      // Incremental: everything changed since the token, deleted events included; a 410 once when asked for.
      if (query.syncToken) {
        if (syncGone.delete(path.calendarId)) return json(res, 410, { error: { status: "GONE" } });
        const since = Number(query.syncToken.replace(/^seq:/, ""));
        return json(res, 200, { items: [...list.values()].filter((e) => e.seq > since).map(asGoogle), nextSyncToken: `seq:${seq}` });
      }
      const from = Date.parse(query.timeMin ?? "1970-01-01T00:00:00Z");
      const to = Date.parse(query.timeMax ?? "9999-01-01T00:00:00Z");
      const items =
        query.showDeleted === "true"
          ? [...list.values()].filter((e) => Date.parse(e.start.dateTime) < to && Date.parse(e.end.dateTime) > from).map(asGoogle)
          : liveEvents(path.calendarId, from, to);
      return json(res, 200, { items, nextSyncToken: `seq:${seq}` });
    }
    if (path.eventId === "watch" && post) {
      const body = JSON.parse(await read(req));
      // Notifications go out from here, so only to this machine.
      if (!body.id || !body.token || !loopback(body.address)) return json(res, 400, { error: { status: "INVALID_ARGUMENT" } });
      const channel = {
        id: body.id,
        calendarId: path.calendarId,
        address: body.address,
        token: body.token,
        resourceId: `fake-resource-${++counter}`,
        expiration: String(Date.now() + Number(body.params?.ttl ?? 604800) * 1000),
      };
      channels.set(channel.id, channel);
      notify(channel, "sync");
      return json(res, 200, { kind: "api#channel", id: channel.id, resourceId: channel.resourceId, expiration: channel.expiration });
    }
    if (path.eventId && req.method === "PATCH") {
      const left = failPatch.get(path.calendarId) ?? 0;
      if (left > 0) {
        failPatch.set(path.calendarId, left - 1);
        return json(res, 503, { error: { status: "UNAVAILABLE" } });
      }
      const event = list.get(path.eventId);
      if (!event || event.status === "cancelled") return json(res, 404, { error: { status: "NOT_FOUND" } });
      const body = JSON.parse(await read(req));
      // Merged like Google; every patch is kept with its query, so tests can check sendUpdates and the order of moves.
      const patched = changed(path.calendarId, { ...event, ...body, patches: [...(event.patches ?? []), { body, query }] });
      const lost = losePatch.get(path.calendarId) ?? 0;
      if (lost > 0) {
        losePatch.set(path.calendarId, lost - 1);
        return json(res, 503, { error: { status: "UNAVAILABLE" } });
      }
      return json(res, 200, patched);
    }
    if (path.eventId && req.method === "DELETE") {
      const event = list.get(path.eventId);
      if (!event || event.status === "cancelled") return json(res, 410, { error: { status: "GONE" } });
      // Deleted events stay as cancelled (as Google lists them with showDeleted), so tests can check the delete.
      changed(path.calendarId, { ...event, status: "cancelled", deleteQuery: query });
      res.writeHead(204);
      return res.end();
    }
    return json(res, 405, { error: { status: "METHOD_NOT_ALLOWED" } });
  }

  if (url.pathname === "/calendar/v3/channels/stop" && post) {
    if (!bearerEmail(req)) return json(res, 401, { error: { status: "UNAUTHENTICATED" } });
    const { id, resourceId } = JSON.parse(await read(req));
    if (channels.get(id)?.resourceId !== resourceId) return json(res, 404, { error: { status: "NOT_FOUND" } });
    channels.delete(id);
    res.writeHead(204);
    return res.end();
  }

  // Test controls.
  // The live channels on one calendar.
  if (url.pathname === "/control/channels") {
    return json(res, 200, { items: [...channels.values()].filter((c) => c.calendarId === url.searchParams.get("calendar")) });
  }
  // The next list with a sync token on this calendar gets a 410.
  if (url.pathname === "/control/sync-gone" && post) {
    syncGone.add(url.searchParams.get("calendar"));
    return json(res, 200, {});
  }
  // Changes as the calendar's owner or a guest would make them in Google, notified like any other change. Body (JSON):
  // create {id, start, end, bookingId?}, move {start, end}, respond {email, responseStatus}; delete takes none.
  if (url.pathname === "/control/calendar" && post) {
    const calendarId = url.searchParams.get("calendar");
    const action = url.searchParams.get("action");
    const body = JSON.parse((await read(req)) || "{}");
    const event = calendarEvents(calendarId).get(action === "create" ? body.id : url.searchParams.get("event"));
    if (action === "create") {
      if (event) return json(res, 409, { error: "exists" });
      return json(res, 200, changed(calendarId, {
        id: body.id,
        status: "confirmed",
        start: { dateTime: body.start },
        end: { dateTime: body.end },
        attendees: body.attendees ?? [],
        ...(body.bookingId ? { extendedProperties: { private: { booking_id: body.bookingId } } } : {}),
      }));
    }
    if (!event) return json(res, 404, { error: "not_found" });
    if (action === "move") return json(res, 200, changed(calendarId, { ...event, start: { dateTime: body.start }, end: { dateTime: body.end } }));
    if (action === "delete") return json(res, 200, changed(calendarId, { ...event, status: "cancelled" }));
    if (action === "respond") {
      const others = (event.attendees ?? []).filter((a) => a.email.toLowerCase() !== body.email.toLowerCase());
      const attendee = (event.attendees ?? []).find((a) => a.email.toLowerCase() === body.email.toLowerCase()) ?? { email: body.email };
      return json(res, 200, changed(calendarId, { ...event, attendees: [...others, { ...attendee, responseStatus: body.responseStatus }] }));
    }
    return json(res, 400, { error: "unknown_action" });
  }
  // Every event of one calendar, deleted ones included (status "cancelled").
  if (url.pathname === "/control/events") return json(res, 200, { items: [...calendarEvents(url.searchParams.get("calendar")).values()] });
  if (url.pathname === "/control/fail-insert" && post) {
    failInsert.set(url.searchParams.get("calendar"), Number(url.searchParams.get("count") ?? 1));
    return json(res, 200, {});
  }
  // The next inserts are created at Google, but the response is lost (a 503 after the commit).
  if (url.pathname === "/control/lose-insert" && post) {
    loseInsert.set(url.searchParams.get("calendar"), Number(url.searchParams.get("count") ?? 1));
    return json(res, 200, {});
  }
  if (url.pathname === "/control/fail-patch" && post) {
    failPatch.set(url.searchParams.get("calendar"), Number(url.searchParams.get("count") ?? 1));
    return json(res, 200, {});
  }
  // The next patches are applied at Google, but the response is lost (a 503 after the commit).
  if (url.pathname === "/control/lose-patch" && post) {
    losePatch.set(url.searchParams.get("calendar"), Number(url.searchParams.get("count") ?? 1));
    return json(res, 200, {});
  }
  if (url.pathname === "/control/busy" && post) {
    busy.set(url.searchParams.get("calendar"), JSON.parse((await read(req)) || "[]"));
    return json(res, 200, {});
  }
  if (url.pathname === "/control/invalidate" && post) {
    invalid.add(url.searchParams.get("email"));
    return json(res, 200, {});
  }
  if (url.pathname === "/control/other-account" && post) {
    otherAccount.set(url.searchParams.get("hint"), url.searchParams.get("email"));
    return json(res, 200, {});
  }
  if (url.pathname === "/control/deny" && post) {
    deny.add(url.searchParams.get("hint"));
    return json(res, 200, {});
  }
  if (url.pathname === "/control/only-scope" && post) {
    onlyScope.set(url.searchParams.get("hint"), url.searchParams.get("scope"));
    return json(res, 200, {});
  }
  if (url.pathname === "/control/fail-exchange" && post) {
    failExchange.add(url.searchParams.get("email"));
    return json(res, 200, {});
  }
  if (url.pathname === "/control/granted") return json(res, 200, { scopes: [...(granted.get(url.searchParams.get("email")) ?? [])] });

  json(res, 404, { error: "not_found" });
}).listen(port, "127.0.0.1", () => console.log(`Google fake listening on http://127.0.0.1:${port}`));
