import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { assertLocalSupabase, baseURL, embedBlockedPort, embedOrigin, embedPort, envFile, googleFakePort, googleFakeUrl, port, smtpHttpUrl, smtpPort } from "./tests/e2e/env";

// Keys of the local Supabase: `npm run stack:up` (or CI after `supabase start`) writes them to .env.e2e.local.
if (existsSync(envFile)) process.loadEnvFile(envFile);
assertLocalSupabase();
// Random per run; workers inherit it, so tests can call the scheduler like pg_cron would.
process.env.SCHEDULER_SECRET ??= randomBytes(24).toString("hex");

export default defineConfig({
  testDir: "tests/e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", testIgnore: /(bootstrap|team-admins)\.spec/, use: { ...devices["Desktop Chrome"] } },
    // Changes the seeded admin's right and the website default, so it starts only after every other spec is done.
    { name: "team-admins", testMatch: /team-admins\.spec/, dependencies: ["chromium"], use: { ...devices["Desktop Chrome"] } },
    // Switches the seeded admins off for a moment, so it starts only after every other spec is done.
    { name: "bootstrap", testMatch: /bootstrap\.spec/, dependencies: ["team-admins"], use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [
    {
      command: "node tests/e2e/google-fake.mjs",
      url: `${googleFakeUrl}/health`,
      env: { GOOGLE_FAKE_PORT: String(googleFakePort) },
      reuseExistingServer: !process.env.CI,
    },
    {
      // Catches every mail the app sends; tests read them back (tests/e2e/mail-helpers.ts).
      command: "node tests/e2e/smtp-sink.mjs",
      url: `${smtpHttpUrl}/health`,
      env: { E2E_SMTP_PORT: String(smtpPort), E2E_SMTP_HTTP_PORT: new URL(smtpHttpUrl).port },
      reuseExistingServer: !process.env.CI,
    },
    {
      // The host website for the widget tests, on an allowed and a blocked origin.
      command: "node tests/e2e/embed-site.mjs",
      url: `${embedOrigin}/health`,
      env: { E2E_APP_URL: baseURL, E2E_EMBED_PORT: String(embedPort), E2E_EMBED_BLOCKED_PORT: String(embedBlockedPort) },
      reuseExistingServer: !process.env.CI,
    },
    {
      // Production build, so headers and caching match what self-hosters run. Brand and locale are set only at start,
      // which proves they are read at runtime and not baked into the build.
      command: `npm run build && BRAND_NAME="Acme Bookings" DEFAULT_LOCALE=en npx next start --hostname 127.0.0.1 --port ${port}`,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      // Supabase keys come from the environment loaded above. APP_URL must be the exact origin the browser uses,
      // or cookies set during OAuth redirects land on another host. The access settings are pinned too: next start
      // would otherwise fill them from a developer's .env.local, and an empty string counts as set (parseConfig
      // reads it as unset).
      env: {
        REQUIRE_SAME_GOOGLE_EMAIL: "false",
        GOOGLE_HOSTED_DOMAIN: "",
        ALLOWED_GOOGLE_DOMAINS: "",
        INITIAL_ADMIN_EMAIL: "",
        // Widgets without origins of their own must not be widened by a developer's .env.local.
        EMBED_ALLOWED_ORIGINS: "",
        TRUST_PROXY_HEADERS: "",
        // Without a trusted proxy every invitee shares one rate limit bucket, parallel tests included. The limit itself
        // is tested on booking_attempt and limit.ts.
        BOOKING_ATTEMPTS_PER_MINUTE: "1000",
        APP_URL: baseURL,
        GOOGLE_FAKE_URL: googleFakeUrl,
        GOOGLE_CLIENT_ID: "fake-client",
        GOOGLE_CLIENT_SECRET: "fake-secret",
        SMTP_URL: `smtp://127.0.0.1:${smtpPort}`,
        MAIL_FROM: "Bookings <bookings@example.com>",
        // Lets tests run the scheduler at a simulated time (x-test-now), scoped to their own booking or member.
        SCHEDULER_TEST_CLOCK: "true",
      },
    },
  ],
});
