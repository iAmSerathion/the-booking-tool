import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import type { BrowserContext } from "@playwright/test";
import { assertLocalSupabase } from "./env";

// Test-only sign-in without Google: the service key creates a magic-link token, verifyOtp turns it into a real Supabase
// session, and its cookies go into the browser. No mail is sent. The product itself has no magic-link login.
assertLocalSupabase();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Seeded members (supabase/seed.sql).
export const adminEmail = "admin.demo@example.com";
export const hostEmail = "host.demo@example.com";

export function admin() {
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Supabase as a signed-out visitor (public key only), for Row Level Security checks.
export function anon() {
  return createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function signInAs(context: BrowserContext, baseURL: string, email: string) {
  const jar = await sessionCookies(email);
  const { hostname, protocol } = new URL(baseURL);
  await context.addCookies(
    [...jar].map(([name, value]) => ({ name, value, domain: hostname, path: "/", sameSite: "Lax" as const, secure: protocol === "https:" })),
  );
}

// Supabase as that member's browser, to check what the database allows them without the app.
export async function userClient(email: string) {
  const jar = await sessionCookies(email);
  return createServerClient(url, anonKey, {
    cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll() {} },
  });
}

// Only the newest magic-link token per account is valid; a parallel test may have replaced it, so retry (not on 429).
export async function sessionCookies(email: string, attempt = 1): Promise<Map<string, string>> {
  const { data, error } = await admin().auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;

  const jar = new Map<string, string>();
  const client = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll(list) {
        for (const { name, value } of list) {
          if (value) jar.set(name, value);
          else jar.delete(name);
        }
      },
    },
  });
  const { error: verifyError } = await client.auth.verifyOtp({ type: "magiclink", token_hash: data.properties.hashed_token });
  if (verifyError && verifyError.status !== 429 && attempt < 6) {
    await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 400 * attempt));
    return sessionCookies(email, attempt + 1);
  }
  if (verifyError) throw verifyError;
  return jar;
}
