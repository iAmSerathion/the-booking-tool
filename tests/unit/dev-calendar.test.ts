import { describe, expect, it } from "vitest";
import { assertLoopback } from "../../scripts/dev-calendar.mjs";

describe("dev-calendar loopback guard", () => {
  it.each(["http://127.0.0.1:54421", "http://localhost:3999/"])("accepts %s", (value) => {
    expect(() => assertLoopback("X", value)).not.toThrow();
  });

  it.each(["https://abc.supabase.co", "http://10.0.0.5:3999", "http://127.0.0.1.example.com", "not a url"])("refuses %s", (value) => {
    expect(() => assertLoopback("X", value)).toThrow(/^X /);
  });
});
