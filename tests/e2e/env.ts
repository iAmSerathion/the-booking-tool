// Shared e2e settings. Playwright loads the local stack's keys from .env.e2e.local (npm run stack:up, or CI).
export const envFile = ".env.e2e.local";
export const port = Number(process.env.E2E_PORT ?? 3100);
export const baseURL = `http://127.0.0.1:${port}`;
export const googleFakePort = Number(process.env.GOOGLE_FAKE_PORT ?? 3999);
export const googleFakeUrl = `http://127.0.0.1:${googleFakePort}`;

// tests/e2e/smtp-sink.mjs: the app sends mail to the SMTP port; tests read it back over HTTP. Both on 127.0.0.1.
export const smtpPort = Number(process.env.E2E_SMTP_PORT ?? 2525);
export const smtpHttpUrl = `http://127.0.0.1:${Number(process.env.E2E_SMTP_HTTP_PORT ?? 2526)}`;

export const supabaseEnvKeys = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;

// Tests create and delete users and rows: refuse anything but a Supabase on this machine.
export function assertLocalSupabase(env: Record<string, string | undefined> = process.env) {
  const missing = supabaseEnvKeys.filter((key) => !env[key]);
  if (missing.length) throw new Error(`Missing ${missing.join(", ")}: run "npm run stack:up" first (it writes ${envFile}).`);
  const { hostname } = new URL(env.NEXT_PUBLIC_SUPABASE_URL!);
  if (!["127.0.0.1", "localhost"].includes(hostname)) throw new Error(`e2e tests only run against a local Supabase, not ${hostname}`);
}
// An origin that widgets created by the tests allow, and one that none allows; tests/e2e/embed-site.mjs serves a host
// page on both.
export const embedPort = Number(process.env.E2E_EMBED_PORT ?? 3101);
export const embedOrigin = `http://127.0.0.1:${embedPort}`;
export const embedBlockedPort = Number(process.env.E2E_EMBED_BLOCKED_PORT ?? 3102);
export const embedBlockedOrigin = `http://127.0.0.1:${embedBlockedPort}`;
