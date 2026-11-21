import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig, readBrandName, readLocale } from "./config";

const valid = {
  APP_URL: "https://booking.example.com/",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54421",
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
  it("treats empty or blank access settings as unset", () => {
    const blank = { ...valid, REQUIRE_SAME_GOOGLE_EMAIL: "", GOOGLE_HOSTED_DOMAIN: "", ALLOWED_GOOGLE_DOMAINS: "", INITIAL_ADMIN_EMAIL: " ", TRUST_PROXY_HEADERS: "" };
    const config = parseConfig(blank);
    expect(config.google).toMatchObject({ requireSameEmail: false, hostedDomain: null, allowedDomains: [] });
    expect(config.initialAdminEmail).toBeNull();
    expect(config.trustProxyHeaders).toBe(false);
  });

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
    expect(config.google.hostedDomain).toBeNull();
    expect(config.initialAdminEmail).toBeNull();
    expect(config.google.requireSameEmail).toBe(false);
    expect(config.google.fakeUrl).toBeNull();
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
      "APP_URL must be an origin only (no path, query, fragment or credentials)",
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

describe("sign-in settings", () => {
  it("lowercases the initial admin email and hosted domain", () => {
    const config = parseConfig({ ...valid, INITIAL_ADMIN_EMAIL: " Admin@Example.com ", GOOGLE_HOSTED_DOMAIN: "Example.com" });
    expect(config.initialAdminEmail).toBe("admin@example.com");
    expect(config.google.hostedDomain).toBe("example.com");
  });

  it("rejects an initial admin that is not an email address", () => {
    expect(problems({ ...valid, INITIAL_ADMIN_EMAIL: "admin" })).toEqual(["INITIAL_ADMIN_EMAIL must be an email address"]);
  });
});

describe("Google calendar settings", () => {
  it("reads REQUIRE_SAME_GOOGLE_EMAIL", () => {
    expect(parseConfig({ ...valid, REQUIRE_SAME_GOOGLE_EMAIL: "true" }).google.requireSameEmail).toBe(true);
    expect(problems({ ...valid, REQUIRE_SAME_GOOGLE_EMAIL: "yes" })).toEqual(["REQUIRE_SAME_GOOGLE_EMAIL must be true or false"]);
  });

  it.each(["http://127.0.0.1:3999", "http://localhost:3999/"])("accepts the fake on loopback: %s", (GOOGLE_FAKE_URL) => {
    expect(parseConfig({ ...valid, GOOGLE_FAKE_URL }).google.fakeUrl).toBe(GOOGLE_FAKE_URL.replace(/\/$/, ""));
  });

  it.each(["https://fake.example.com", "http://10.0.0.5:3999", "http://127.0.0.1.example.com"])("refuses a fake that is not on loopback: %s", (GOOGLE_FAKE_URL) => {
    expect(problems({ ...valid, GOOGLE_FAKE_URL })).toEqual(["GOOGLE_FAKE_URL is for tests only and must point at localhost or 127.0.0.1"]);
  });

  it("refuses a fake URL that is not http(s)", () => {
    expect(problems({ ...valid, GOOGLE_FAKE_URL: "ftp://127.0.0.1" })).toEqual(["GOOGLE_FAKE_URL must be a http: or https: URL"]);
  });
});

describe("APP_URL", () => {
  it.each(["https://booking.example.com/?x=1", "https://booking.example.com/#a", "https://user:pw@booking.example.com"])("rejects %s", (APP_URL) => {
    expect(problems({ ...valid, APP_URL })).toEqual(["APP_URL must be an origin only (no path, query, fragment or credentials)"]);
  });

  it("keeps a port", () => {
    expect(parseConfig({ ...valid, APP_URL: "http://localhost:3000" }).appUrl).toBe("http://localhost:3000");
  });
});

describe("EMBED_ALLOWED_ORIGINS", () => {
  it("is empty by default and normalizes listed origins", () => {
    expect(parseConfig(valid).embedAllowedOrigins).toEqual([]);
    expect(parseConfig({ ...valid, EMBED_ALLOWED_ORIGINS: " https://WWW.example.com/ , http://127.0.0.1:3101,https://www.example.com" }).embedAllowedOrigins).toEqual([
      "https://www.example.com",
      "http://127.0.0.1:3101",
    ]);
  });

  it("rejects anything that is not an embeddable origin", () => {
    for (const bad of ["*", "https://example.com/path", "http://example.com", "https://example.com; script-src *"]) {
      expect(problems({ ...valid, EMBED_ALLOWED_ORIGINS: bad })).toEqual([expect.stringMatching(/^EMBED_ALLOWED_ORIGINS must be/)]);
    }
    const many = Array.from({ length: 21 }, (_, i) => `https://s${i}.example.com`).join(",");
    expect(problems({ ...valid, EMBED_ALLOWED_ORIGINS: many })).toHaveLength(1);
  });
});

it("stores the canonical time zone name", () => {
  expect(parseConfig({ ...valid, DEFAULT_TIMEZONE: "europe/berlin" }).timeZone).toBe("Europe/Berlin");
});

describe("layout helpers", () => {
  it("fall back without throwing", () => {
    expect(readLocale({ DEFAULT_LOCALE: "xx" })).toBe("de");
    expect(readLocale({ DEFAULT_LOCALE: "en" })).toBe("en");
    expect(readBrandName({ BRAND_NAME: "  " })).toBe("the-booking-tool");
    expect(readBrandName({ BRAND_NAME: "Acme Bookings" })).toBe("Acme Bookings");
  });
});

describe("scheduler test clock", () => {
  it("is off by default", () => {
    expect(parseConfig(valid).schedulerTestClock).toBe(false);
  });

  it.each(["http://127.0.0.1:3100", "http://localhost:3100", "http://[::1]:3100"])("is allowed with a loopback APP_URL: %s", (APP_URL) => {
    expect(parseConfig({ ...valid, APP_URL, SCHEDULER_TEST_CLOCK: "true" }).schedulerTestClock).toBe(true);
  });

  it.each(["https://booking.example.com", "http://127.0.0.1.example.com", "http://10.0.0.5:3100"])("is refused with any other APP_URL: %s", (APP_URL) => {
    expect(problems({ ...valid, APP_URL, SCHEDULER_TEST_CLOCK: "true" })).toEqual([
      "SCHEDULER_TEST_CLOCK is for tests only and needs a loopback APP_URL (localhost, 127.0.0.1 or [::1])",
    ]);
  });

  it("must be true or false", () => {
    expect(problems({ ...valid, SCHEDULER_TEST_CLOCK: "1" })).toEqual(["SCHEDULER_TEST_CLOCK must be true or false"]);
  });
});
