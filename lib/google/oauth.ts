import { randomBytes, timingSafeEqual } from "node:crypto";
import { type Config, getConfig } from "@/lib/config";
import { calendarScope, identityScopes } from "./scopes";

// Per-member Google Calendar connection: its own OAuth flow with a refresh token, separate from the Supabase sign-in.
// Server code only.

// GOOGLE_FAKE_URL (tests only, loopback enforced by parseConfig) swaps every Google host for the e2e fake.
const host = (real: string, config: Config) => config.google.fakeUrl ?? real;

export const googleUrls = {
  auth: (config = getConfig()) => `${host("https://accounts.google.com", config)}/o/oauth2/v2/auth`,
  token: (config = getConfig()) => `${host("https://oauth2.googleapis.com", config)}/token`,
  revoke: (config = getConfig()) => `${host("https://oauth2.googleapis.com", config)}/revoke`,
  calendar: (config = getConfig()) => `${host("https://www.googleapis.com", config)}/calendar/v3`,
};

// Built from APP_URL only. consentUrl and exchangeCode must send the exact same string, or Google refuses the code.
export const callbackUrl = (config = getConfig()) => `${config.appUrl}/api/google/callback`;

// Holds "<state>.<user id>" between "Connect" and Google's redirect back, so the callback only accepts a flow that this
// browser started for this member.
export const stateCookie = "tbt_google_oauth";

export function stateCookieOptions(config = getConfig()) {
  // From APP_URL, not the request: behind a TLS proxy Next sees plain http.
  return { httpOnly: true, secure: config.appUrl.startsWith("https:"), sameSite: "lax" as const, path: "/api/google", maxAge: 600 };
}

export function newState(userId: string) {
  const state = randomBytes(24).toString("base64url");
  return { state, cookie: `${state}.${userId}` };
}

export function stateMatches(cookie: string | undefined, state: string | null, userId: string): boolean {
  const expected = Buffer.from(`${state ?? ""}.${userId}`);
  const actual = Buffer.from(cookie ?? "");
  return !!state && actual.length === expected.length && timingSafeEqual(actual, expected);
}

// offline + prompt=consent: Google returns a refresh token every time, also on a reconnect.
export function consentUrl({ state, email }: { state: string; email: string }, config = getConfig()) {
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: callbackUrl(config),
    response_type: "code",
    scope: [...identityScopes, calendarScope].join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    login_hint: email,
    state,
  });
  if (config.google.hostedDomain) params.set("hd", config.google.hostedDomain);
  return `${googleUrls.auth(config)}?${params}`;
}

export type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string; scope?: string; id_token?: string };

export class GoogleError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`Google: ${code} (${status})`);
  }
}

function postForm(url: string, body: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    cache: "no-store",
  });
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const { clientId, clientSecret } = getConfig().google;
  const response = await postForm(googleUrls.token(), { ...body, client_id: clientId, client_secret: clientSecret });
  const data = (await response.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
  if (!response.ok || !data.access_token) throw new GoogleError(data.error ?? "unknown", response.status);
  return data as TokenResponse;
}

export function exchangeCode(code: string): Promise<TokenResponse> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: callbackUrl() });
}

export function refreshAccess(refreshToken: string): Promise<TokenResponse> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

// Best effort: if Google fails (token already dead), the connection is still removed on our side.
export async function revokeToken(token: string): Promise<void> {
  await postForm(googleUrls.revoke(), { token }).catch(() => undefined);
}

// The email from the id_token. It comes straight from Google's token endpoint over TLS, so the signature is not checked
// (OpenID Connect Core 3.1.3.7).
export function idTokenEmail(idToken: string | undefined): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown; email_verified?: unknown };
    return typeof claims.email === "string" && claims.email_verified !== false ? claims.email.toLowerCase() : null;
  } catch {
    return null;
  }
}
