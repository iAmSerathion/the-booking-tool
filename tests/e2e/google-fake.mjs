// Test-only stand-in for the Google endpoints the app calls: OAuth consent, token, revoke, calendar list, free/busy and
// events (insert with Meet, move, delete, list).
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

let granted, invalid, otherAccount, busy, events, failInsert, loseInsert, failPatch, counter, deny, onlyScope, failExchange;
const reset = () => {
  granted = new Map(); // email -> granted scopes
  invalid = new Set(); // emails whose refresh tokens Google no longer accepts
  otherAccount = new Map(); // login_hint -> email the next consent signs in with instead
  busy = new Map(); // calendar id -> [{ start, end }] ISO instants
  events = new Map(); // calendar id -> Map(event id -> { id, status, query, deleteQuery?, ...body })
  failInsert = new Map(); // calendar id -> how many of the next event inserts fail with a 503
  loseInsert = new Map(); // calendar id -> how many of the next event inserts are created but answered with a 503
  failPatch = new Map(); // calendar id -> how many of the next event patches fail with a 503
  deny = new Set(); // login_hints whose next consent is cancelled
  onlyScope = new Map(); // login_hint -> the only scope the next consent grants
  failExchange = new Set(); // emails whose next code exchange fails
  counter = 0;
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
      list.set(id, event);
      const lost = loseInsert.get(path.calendarId) ?? 0;
      if (lost > 0) {
        loseInsert.set(path.calendarId, lost - 1);
        return json(res, 503, { error: { status: "UNAVAILABLE" } });
      }
      return json(res, 200, event);
    }
    if (!path.eventId && req.method === "GET") {
      const from = Date.parse(query.timeMin ?? "1970-01-01T00:00:00Z");
      const to = Date.parse(query.timeMax ?? "9999-01-01T00:00:00Z");
      return json(res, 200, { items: liveEvents(path.calendarId, from, to) });
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
      const patched = { ...event, ...body, patches: [...(event.patches ?? []), { body, query }] };
      list.set(path.eventId, patched);
      return json(res, 200, patched);
    }
    if (path.eventId && req.method === "DELETE") {
      const event = list.get(path.eventId);
      if (!event || event.status === "cancelled") return json(res, 410, { error: { status: "GONE" } });
      // Deleted events stay as cancelled (as Google lists them with showDeleted), so tests can check the delete.
      list.set(path.eventId, { ...event, status: "cancelled", deleteQuery: query });
      res.writeHead(204);
      return res.end();
    }
    return json(res, 405, { error: { status: "METHOD_NOT_ALLOWED" } });
  }

  // Test controls.
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
}).listen(port, "127.0.0.1");
