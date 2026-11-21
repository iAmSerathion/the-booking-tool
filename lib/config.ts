import { embedOriginPattern, maxEmbedOrigins } from "@/lib/core/widget";

// Instance configuration from environment variables. Server-only: most values are secrets.
// Read it with getConfig(); it throws once, listing every missing or invalid variable.

type Env = Record<string, string | undefined>;

export const locales = ["de", "en"] as const;
export type Locale = (typeof locales)[number];

export const requiredEnvKeys = [
  "APP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "SCHEDULER_SECRET",
  "SMTP_URL",
  "MAIL_FROM",
] as const;

export const optionalEnvKeys = [
  "BRAND_NAME",
  "BRAND_LOGO_URL",
  "PRIVACY_URL",
  "IMPRINT_URL",
  "DEFAULT_LOCALE",
  "DEFAULT_TIMEZONE",
  "ALLOWED_GOOGLE_DOMAINS",
  "GOOGLE_HOSTED_DOMAIN",
  "INITIAL_ADMIN_EMAIL",
  "REQUIRE_SAME_GOOGLE_EMAIL",
  "GOOGLE_FAKE_URL",
  "TRUST_PROXY_HEADERS",
  "BOOKING_ATTEMPTS_PER_MINUTE",
  "WEBHOOK_URL",
  "WEBHOOK_SECRET",
  "EMBED_ALLOWED_ORIGINS",
] as const;

export type Config = {
  appUrl: string;
  supabase: { url: string; anonKey: string; serviceRoleKey: string };
  google: {
    clientId: string;
    clientSecret: string;
    allowedDomains: string[];
    hostedDomain: string | null;
    requireSameEmail: boolean;
    // Test only: base URL of tests/e2e/google-fake.mjs instead of Google. Always a loopback host.
    fakeUrl: string | null;
  };
  initialAdminEmail: string | null;
  schedulerSecret: string;
  mail: { smtpUrl: string; from: string };
  brand: { name: string; logoUrl: string | null; privacyUrl: string | null; imprintUrl: string | null };
  locale: Locale;
  timeZone: string;
  trustProxyHeaders: boolean;
  bookingAttemptsPerMinute: number;
  webhook: { url: string; secret: string } | null;
  // Origins that may embed widgets which list no origins of their own.
  embedAllowedOrigins: string[];
};

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

const clean = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

// Used by the root layout, which must render even before the instance is fully configured.
export function readLocale(env: Env = process.env): Locale {
  const value = clean(env.DEFAULT_LOCALE);
  return (locales as readonly string[]).includes(value ?? "") ? (value as Locale) : "de";
}

export function readBrandName(env: Env = process.env): string {
  return clean(env.BRAND_NAME) ?? "the-booking-tool";
}

export function parseConfig(env: Env): Config {
  const problems: string[] = [];
  const get = (key: string) => clean(env[key]);

  for (const key of requiredEnvKeys) if (!get(key)) problems.push(`${key} is required`);

  const url = (key: string, protocols: string[]) => {
    const value = get(key);
    if (!value) return null;
    try {
      const parsed = new URL(value);
      if (!protocols.includes(parsed.protocol)) throw new Error();
      return value.replace(/\/+$/, "");
    } catch {
      problems.push(`${key} must be a ${protocols.join(" or ")} URL`);
      return null;
    }
  };

  let appUrl = url("APP_URL", ["https:", "http:"]);
  if (appUrl) {
    const origin = new URL(appUrl).origin;
    if (origin !== appUrl) problems.push("APP_URL must be an origin only (no path, query, fragment or credentials)");
    appUrl = origin;
  }
  const supabaseUrl = url("NEXT_PUBLIC_SUPABASE_URL", ["https:", "http:"]);
  const smtpUrl = url("SMTP_URL", ["smtp:", "smtps:"]);
  const logoUrl = url("BRAND_LOGO_URL", ["https:"]);
  const privacyUrl = url("PRIVACY_URL", ["https:", "http:"]);
  const imprintUrl = url("IMPRINT_URL", ["https:", "http:"]);
  const webhookUrl = url("WEBHOOK_URL", ["https:", "http:"]);

  const schedulerSecret = get("SCHEDULER_SECRET") ?? "";
  if (schedulerSecret && schedulerSecret.length < 32) problems.push("SCHEDULER_SECRET must be at least 32 characters");

  const locale = get("DEFAULT_LOCALE");
  if (locale && !(locales as readonly string[]).includes(locale)) problems.push(`DEFAULT_LOCALE must be one of: ${locales.join(", ")}`);

  let timeZone = get("DEFAULT_TIMEZONE") ?? "Europe/Berlin";
  try {
    // Intl accepts any casing; store the canonical name that Postgres and Google expect.
    timeZone = new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone;
  } catch {
    problems.push("DEFAULT_TIMEZONE must be an IANA time zone, e.g. Europe/Berlin");
  }

  const trustProxy = get("TRUST_PROXY_HEADERS") ?? "false";
  if (!["true", "false"].includes(trustProxy)) problems.push("TRUST_PROXY_HEADERS must be true or false");

  const attempts = Number(get("BOOKING_ATTEMPTS_PER_MINUTE") ?? "10");
  if (!Number.isInteger(attempts) || attempts < 1) problems.push("BOOKING_ATTEMPTS_PER_MINUTE must be a positive integer");

  const initialAdminEmail = get("INITIAL_ADMIN_EMAIL")?.toLowerCase() ?? null;
  if (initialAdminEmail && !/^[^@\s]+@[^@\s]+$/.test(initialAdminEmail)) problems.push("INITIAL_ADMIN_EMAIL must be an email address");

  const requireSameEmail = get("REQUIRE_SAME_GOOGLE_EMAIL") ?? "false";
  if (!["true", "false"].includes(requireSameEmail)) problems.push("REQUIRE_SAME_GOOGLE_EMAIL must be true or false");

  // The fake hands out tokens to anyone, so it must never be reachable from outside this machine.
  const fakeUrl = url("GOOGLE_FAKE_URL", ["http:", "https:"]);
  if (fakeUrl && !["localhost", "127.0.0.1"].includes(new URL(fakeUrl).hostname)) {
    problems.push("GOOGLE_FAKE_URL is for tests only and must point at localhost or 127.0.0.1");
  }

  const webhookSecret = get("WEBHOOK_SECRET");
  if (get("WEBHOOK_URL") && !webhookSecret) problems.push("WEBHOOK_SECRET is required when WEBHOOK_URL is set");
  if (webhookSecret && webhookSecret.length < 32) problems.push("WEBHOOK_SECRET must be at least 32 characters");

  const embedAllowedOrigins = (get("EMBED_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((o) => o.trim().toLowerCase().replace(/\/+$/, ""))
    .filter(Boolean);
  if (embedAllowedOrigins.length > maxEmbedOrigins || !embedAllowedOrigins.every((o) => embedOriginPattern.test(o))) {
    problems.push(`EMBED_ALLOWED_ORIGINS must be at most ${maxEmbedOrigins} comma-separated origins like https://www.example.com (plain http only for localhost or 127.0.0.1)`);
  }

  if (problems.length) throw new ConfigError(problems);

  return {
    appUrl: appUrl!,
    supabase: { url: supabaseUrl!, anonKey: get("NEXT_PUBLIC_SUPABASE_ANON_KEY")!, serviceRoleKey: get("SUPABASE_SERVICE_ROLE_KEY")! },
    google: {
      clientId: get("GOOGLE_CLIENT_ID")!,
      clientSecret: get("GOOGLE_CLIENT_SECRET")!,
      allowedDomains: (get("ALLOWED_GOOGLE_DOMAINS") ?? "")
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
      hostedDomain: get("GOOGLE_HOSTED_DOMAIN")?.toLowerCase() ?? null,
      requireSameEmail: requireSameEmail === "true",
      fakeUrl,
    },
    initialAdminEmail,
    schedulerSecret,
    mail: { smtpUrl: smtpUrl!, from: get("MAIL_FROM")! },
    brand: { name: readBrandName(env), logoUrl, privacyUrl, imprintUrl },
    locale: readLocale(env),
    timeZone,
    trustProxyHeaders: trustProxy === "true",
    bookingAttemptsPerMinute: attempts,
    webhook: webhookUrl && webhookSecret ? { url: webhookUrl, secret: webhookSecret } : null,
    embedAllowedOrigins: [...new Set(embedAllowedOrigins)],
  };
}

let cached: Config | undefined;

export function getConfig(): Config {
  return (cached ??= parseConfig(process.env));
}
