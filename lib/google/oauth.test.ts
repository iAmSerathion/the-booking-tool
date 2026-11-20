import { describe, expect, it } from "vitest";
import { parseConfig } from "@/lib/config";
import { callbackUrl, consentUrl, googleUrls, idTokenEmail, newState, stateCookieOptions, stateMatches } from "./oauth";
import { calendarScope, grantedScopes, scopesAfterConnect } from "./scopes";

const env = {
  APP_URL: "https://booking.example.com",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54421",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  GOOGLE_CLIENT_ID: "client",
  GOOGLE_CLIENT_SECRET: "secret",
  SCHEDULER_SECRET: "x".repeat(32),
  SMTP_URL: "smtp://127.0.0.1:2525",
  MAIL_FROM: "bookings@example.com",
};
const config = parseConfig(env);
const userId = "00000000-0000-4000-8000-000000000002";

const jwt = (claims: object) => `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;

describe("consentUrl", () => {
  it("asks real Google for an offline calendar grant with the APP_URL callback", () => {
    const url = new URL(consentUrl({ state: "s1", email: "host.demo@example.com" }, config));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client",
      redirect_uri: "https://booking.example.com/api/google/callback",
      response_type: "code",
      scope: `openid email profile ${calendarScope}`,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      login_hint: "host.demo@example.com",
      state: "s1",
    });
  });

  it("adds hd only when GOOGLE_HOSTED_DOMAIN is set", () => {
    const url = new URL(consentUrl({ state: "s", email: "a@example.com" }, parseConfig({ ...env, GOOGLE_HOSTED_DOMAIN: "Example.com" })));
    expect(url.searchParams.get("hd")).toBe("example.com");
  });

  it("uses the fake for every Google host when GOOGLE_FAKE_URL is set", () => {
    const faked = parseConfig({ ...env, GOOGLE_FAKE_URL: "http://127.0.0.1:3999" });
    expect(consentUrl({ state: "s", email: "a@example.com" }, faked)).toMatch(/^http:\/\/127\.0\.0\.1:3999\/o\/oauth2\/v2\/auth\?/);
    expect([googleUrls.token(faked), googleUrls.revoke(faked), googleUrls.calendar(faked)]).toEqual([
      "http://127.0.0.1:3999/token",
      "http://127.0.0.1:3999/revoke",
      "http://127.0.0.1:3999/calendar/v3",
    ]);
    expect(googleUrls.token(config)).toBe("https://oauth2.googleapis.com/token");
  });

  it("builds the callback from APP_URL", () => {
    expect(callbackUrl(config)).toBe("https://booking.example.com/api/google/callback");
  });
});

describe("state", () => {
  it("accepts only the state and member the flow started with", () => {
    const { state, cookie } = newState(userId);
    expect(stateMatches(cookie, state, userId)).toBe(true);
    expect(stateMatches(cookie, `${state}x`, userId)).toBe(false);
    expect(stateMatches(cookie, state, "00000000-0000-4000-8000-000000000001")).toBe(false);
    expect(stateMatches(undefined, state, userId)).toBe(false);
    expect(stateMatches(cookie, null, userId)).toBe(false);
    expect(stateMatches(`.${userId}`, "", userId)).toBe(false);
  });

  it("is random per flow", () => {
    expect(newState(userId).state).not.toBe(newState(userId).state);
  });

  it("sets a secure cookie only for an https APP_URL", () => {
    expect(stateCookieOptions(config)).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/api/google" });
    expect(stateCookieOptions(parseConfig({ ...env, APP_URL: "http://127.0.0.1:3100" })).secure).toBe(false);
  });
});

describe("idTokenEmail", () => {
  it("reads a verified email in lower case", () => {
    expect(idTokenEmail(jwt({ email: "Host.Demo@Example.com", email_verified: true }))).toBe("host.demo@example.com");
  });

  it.each([["unverified", jwt({ email: "a@example.com", email_verified: false })], ["no email", jwt({})], ["garbage", "a.%%%.c"], ["missing", undefined]])(
    "returns null when %s",
    (_, token) => {
      expect(idTokenEmail(token)).toBeNull();
    },
  );
});

describe("scopes", () => {
  it("stores the calendar scope only when Google granted it", () => {
    expect(scopesAfterConnect(grantedScopes(`openid email ${calendarScope}`))).toEqual([calendarScope]);
    expect(scopesAfterConnect(grantedScopes("openid email profile"))).toBeNull();
    expect(grantedScopes(undefined)).toEqual([]);
  });
});
