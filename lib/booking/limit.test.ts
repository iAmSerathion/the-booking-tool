import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/db/admin", () => ({ createAdminSupabase: () => null }));
const { clientKey } = await import("./limit");

describe("clientKey", () => {
  const forwarded = new Headers({ "x-forwarded-for": "198.51.100.1, 203.0.113.7", "x-real-ip": "198.51.100.9" });

  it("ignores proxy headers unless they are trusted", () => {
    expect(clientKey(forwarded, false)).toBe("direct");
  });

  it("takes the rightmost X-Forwarded-For hop, which the trusted proxy appended", () => {
    expect(clientKey(forwarded, true)).toBe("203.0.113.7");
    expect(clientKey(new Headers({ "x-forwarded-for": " 203.0.113.7 ,, " }), true)).toBe("203.0.113.7");
  });

  it("falls back to the shared key without the header", () => {
    expect(clientKey(new Headers(), true)).toBe("direct");
  });
});
