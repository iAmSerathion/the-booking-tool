// Development only: connects the seeded host (host.demo@example.com, page /demo-host) to the Google fake
// (tests/e2e/google-fake.mjs), so the local booking pages show free times without a Google OAuth client. It writes to
// the database with the service role key, so it refuses any Supabase or fake that is not on this machine.
// Usage: npm run stack:up, node tests/e2e/google-fake.mjs, then npm run dev:calendar.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

export const hostEmail = "host.demo@example.com";
const calendarScope = "https://www.googleapis.com/auth/calendar";

// The same rule as GOOGLE_FAKE_URL in lib/config.ts: only localhost or 127.0.0.1.
export function assertLoopback(name, value) {
  let hostname;
  try {
    hostname = new URL(value).hostname;
  } catch {
    throw new Error(`${name} is not a URL: ${value}`);
  }
  if (!["127.0.0.1", "localhost"].includes(hostname)) throw new Error(`${name} must point at localhost or 127.0.0.1, not ${hostname}`);
}

async function main() {
  // The stack's keys; fall back to whatever the environment already has.
  if (existsSync(".env.e2e.local")) process.loadEnvFile(".env.e2e.local");
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const fakeUrl = (process.env.GOOGLE_FAKE_URL || "http://127.0.0.1:3999").replace(/\/$/, "");
  if (!supabaseUrl || !serviceKey) throw new Error('No Supabase keys: run "npm run stack:up" first (it writes .env.e2e.local).');
  assertLoopback("NEXT_PUBLIC_SUPABASE_URL", supabaseUrl);
  assertLoopback("GOOGLE_FAKE_URL", fakeUrl);

  const health = await fetch(`${fakeUrl}/health`).catch(() => null);
  if (!health?.ok) throw new Error(`The Google fake does not answer at ${fakeUrl}: start it with "node tests/e2e/google-fake.mjs".`);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: profile, error } = await db.from("profiles").select("id").eq("email", hostEmail).maybeSingle();
  if (error) throw error;
  if (!profile) throw new Error(`${hostEmail} is not in the database: run "npm run stack:up" (it applies the seed).`);

  // Consent and code exchange at the fake, as the settings page would do (tests/e2e/booking-helpers.ts does the same).
  const redirectUri = "http://127.0.0.1/dev-callback";
  const consent = await fetch(
    `${fakeUrl}/o/oauth2/v2/auth?${new URLSearchParams({ client_id: "fake-client", redirect_uri: redirectUri, login_hint: hostEmail, scope: calendarScope })}`,
    { redirect: "manual" },
  );
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  const tokens = await fetch(`${fakeUrl}/token`, {
    method: "POST",
    body: new URLSearchParams({ client_id: "fake-client", client_secret: "fake-secret", grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  }).then((r) => r.json());
  if (!tokens.refresh_token) throw new Error(`The Google fake returned no refresh token: ${JSON.stringify(tokens)}`);

  const { error: saveError } = await db.rpc("google_connection_save", {
    p_user_id: profile.id,
    p_account_email: hostEmail,
    p_refresh_token: tokens.refresh_token,
    p_scopes: [calendarScope],
    p_primary_calendar_id: hostEmail,
  });
  if (saveError) throw saveError;
  console.log(`${hostEmail} is connected to the Google fake at ${fakeUrl}. Open /demo-host or / on the dev server and book a time.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exit(1);
  });
}
