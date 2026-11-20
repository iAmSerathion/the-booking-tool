import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig, readBrandName, readLocale } from "./config";

const valid = {
  APP_URL: "https://booking.example.com/",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  GOOGLE_CLIENT_ID: "client",
  GOOGLE_CLIENT_SECRET: "secret",
  SCHEDULER_SECRET: "x".repeat(32),
  SMTP_URL: "smtps://user:pass@smtp.example.com:465",
  MAIL_FROM: "Bookings <bookings@example.com>",
};

const problems = (env: Record<string, string>) => {
  try {
    parseConfig(env);
    return [];
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
};

describe("parseConfig", () => {
  it("reads a minimal valid environment with defaults", () => {
    const config = parseConfig(valid);
    expect(config.appUrl).toBe("https://booking.example.com");
    expect(config.locale).toBe("de");
    expect(config.timeZone).toBe("Europe/Berlin");
    expect(config.brand.name).toBe("the-booking-tool");
    expect(config.google.allowedDomains).toEqual([]);
    expect(config.trustProxyHeaders).toBe(false);
    expect(config.bookingAttemptsPerMinute).toBe(10);
    expect(config.webhook).toBeNull();
  });

  it("lists every missing required variable at once", () => {
    const list = problems({});
    expect(list).toContain("APP_URL is required");
    expect(list).toContain("SMTP_URL is required");
    expect(list).toHaveLength(9);
  });

  it("rejects invalid values", () => {
    const list = problems({
      ...valid,
      APP_URL: "https://booking.example.com/app",
      SMTP_URL: "https://smtp.example.com",
      SCHEDULER_SECRET: "short",
      DEFAULT_LOCALE: "fr",
      DEFAULT_TIMEZONE: "Mars/Olympus",
      TRUST_PROXY_HEADERS: "yes",
      BOOKING_ATTEMPTS_PER_MINUTE: "0",
      BRAND_LOGO_URL: "http://example.com/logo.png",
    });
    expect(list).toEqual([
      "APP_URL must be an origin without a path",
      "SMTP_URL must be a smtp: or smtps: URL",
      "BRAND_LOGO_URL must be a https: URL",
      "SCHEDULER_SECRET must be at least 32 characters",
      "DEFAULT_LOCALE must be one of: de, en",
      "DEFAULT_TIMEZONE must be an IANA time zone, e.g. Europe/Berlin",
      "TRUST_PROXY_HEADERS must be true or false",
      "BOOKING_ATTEMPTS_PER_MINUTE must be a positive integer",
    ]);
  });

  it("needs a strong secret with a webhook URL", () => {
    expect(problems({ ...valid, WEBHOOK_URL: "https://hooks.example.com" })).toEqual(["WEBHOOK_SECRET is required when WEBHOOK_URL is set"]);
    const config = parseConfig({ ...valid, WEBHOOK_URL: "https://hooks.example.com/", WEBHOOK_SECRET: "s".repeat(32) });
    expect(config.webhook).toEqual({ url: "https://hooks.example.com", secret: "s".repeat(32) });
  });

  it("normalizes allowed Google domains", () => {
    expect(parseConfig({ ...valid, ALLOWED_GOOGLE_DOMAINS: " Example.com, ,other.org " }).google.allowedDomains).toEqual(["example.com", "other.org"]);
  });
});

describe("layout helpers", () => {
  it("fall back without throwing", () => {
    expect(readLocale({ DEFAULT_LOCALE: "xx" })).toBe("de");
    expect(readLocale({ DEFAULT_LOCALE: "en" })).toBe("en");
    expect(readBrandName({ BRAND_NAME: "  " })).toBe("the-booking-tool");
    expect(readBrandName({ BRAND_NAME: "Acme Bookings" })).toBe("Acme Bookings");
  });
});
