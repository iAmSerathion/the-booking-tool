import { describe, expect, it } from "vitest";
import { assertLoopback } from "../../scripts/dev-login.mjs";

describe("dev-login loopback guard", () => {
  it.each(["http://127.0.0.1:54421", "http://localhost:3000/", "http://[::1]:3000"])("accepts %s", (value) => {
    expect(() => assertLoopback("X", value)).not.toThrow();
  });

  it.each(["https://abc.supabase.co", "https://booking.example.com", "http://10.0.0.5:3000", "http://127.0.0.1.example.com", "http://[::2]:3000", "not a url"])(
    "refuses %s",
    (value) => {
      expect(() => assertLoopback("X", value)).toThrow(/^X /);
    },
  );
});
