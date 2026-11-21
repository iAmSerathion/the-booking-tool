// Development only: signs you in to the local dev server without Google. It makes a magic-link session with the service
// role key (as tests/e2e/session.ts does), then serves a one-time URL on loopback that puts the session cookies into
// your browser and redirects to <APP_URL>/app. Cookies are per host, not per port, so the dev server sees them.
// The app itself has no magic-link login: /auth/callback admits Google identities only. This script refuses any
// Supabase or APP_URL that is not on this machine.
// Usage: npm run stack:up, npm run dev, then npm run dev:login [email] (default the seeded admin).
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export const adminEmail = "admin.demo@example.com";
const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];

export function assertLoopback(name, value) {
  let hostname;
  try {
    hostname = new URL(value).hostname;
  } catch {
    throw new Error(`${name} is not a URL: ${value}`);
  }
  if (!loopbackHosts.includes(hostname)) throw new Error(`${name} must point at localhost, 127.0.0.1 or [::1], not ${hostname}`);
}

async function sessionCookies(supabaseUrl, anonKey, serviceKey, email) {
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(`${email}: ${error.message}`);
  const jar = new Map();
  const client = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const { error: verifyError } = await client.auth.verifyOtp({ type: "magiclink", token_hash: data.properties.hashed_token });
  if (verifyError) throw verifyError;
  return jar;
}

async function main() {
  // Fresh stack keys first; .env.local only fills what is still missing (APP_URL). loadEnvFile never overrides.
  for (const file of [".env.e2e.local", ".env.local"]) if (existsSync(file)) process.loadEnvFile(file);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const appUrl = new URL(process.env.APP_URL || "http://127.0.0.1:3000");
  if (!supabaseUrl || !anonKey || !serviceKey) throw new Error('No Supabase keys: run "npm run stack:up" first (it writes .env.e2e.local).');
  assertLoopback("NEXT_PUBLIC_SUPABASE_URL", supabaseUrl);
  assertLoopback("APP_URL", appUrl.href);

  const email = (process.argv[2] || adminEmail).toLowerCase();
  const jar = await sessionCookies(supabaseUrl, anonKey, serviceKey, email);
  const path = `/${randomBytes(16).toString("hex")}`;
  const secure = appUrl.protocol === "https:" ? "; Secure" : "";

  // shortcut: "localhost" binds 127.0.0.1 only; a browser that resolves localhost to ::1 falls back to 127.0.0.1.
  const bindHost = appUrl.hostname === "[::1]" ? "::1" : "127.0.0.1";
  const server = createServer((req, res) => {
    if (req.url !== path) return res.writeHead(404).end();
    res.writeHead(302, {
      "Set-Cookie": [...jar].map(([name, value]) => `${name}=${value}; Path=/; SameSite=Lax${secure}`),
      Location: new URL("/app", appUrl).href,
    });
    res.end(() => server.close());
    console.log("Signed in. The URL is used up.");
  });
  server.listen(0, bindHost, () => {
    console.log(`One-time sign-in for ${email} (open within 10 minutes):`);
    console.log(`http://${appUrl.hostname}:${server.address().port}${path}`);
  });
  setTimeout(() => {
    console.error("Not opened within 10 minutes; run it again.");
    process.exit(1);
  }, 600_000).unref();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exit(1);
  });
}
