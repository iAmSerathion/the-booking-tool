// Test-only stand-in for the Google endpoints the app calls: OAuth consent, token, revoke, calendar list and free/busy.
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

let granted, invalid, otherAccount, busy, counter;
const reset = () => {
  granted = new Map(); // email -> granted scopes
  invalid = new Set(); // emails whose refresh tokens Google no longer accepts
  otherAccount = new Map(); // login_hint -> email the next consent signs in with instead
  busy = new Map(); // calendar id -> [{ start, end }] ISO instants
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

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const post = req.method === "POST";

  if (url.pathname === "/health") return json(res, 200, { ok: true });
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
    back.searchParams.set("code", encode({ email, scope: url.searchParams.get("scope") ?? "", redirectUri }));
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
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
    const calendars = Object.fromEntries(
      items.map(({ id }) => [id, { busy: (busy.get(id) ?? []).filter((b) => Date.parse(b.start) < to && Date.parse(b.end) > from) }]),
    );
    return json(res, 200, { kind: "calendar#freeBusy", timeMin, timeMax, calendars });
  }

  // Test controls.
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
  if (url.pathname === "/control/granted") return json(res, 200, { scopes: [...(granted.get(url.searchParams.get("email")) ?? [])] });

  json(res, 404, { error: "not_found" });
}).listen(port, "127.0.0.1");
