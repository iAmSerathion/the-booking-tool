import { describe, expect, it } from "vitest";
import { embedOriginPattern, isWidgetId, widgetConfirmationPath, widgetEmbedOrigins, widgetFrameAncestors, widgetPath } from "./widget";

const app = "https://booking.example.com";
const id = "00000000-0000-4000-8000-000000000201";

describe("widgetFrameAncestors", () => {
  it("is 'none' for an unknown or inactive widget, whatever the lists say", () => {
    expect(widgetFrameAncestors(null, ["https://example.com"], app)).toBe("'none'");
    expect(widgetFrameAncestors({ active: false, allowed_origins: ["https://example.com"] }, ["https://example.org"], app)).toBe("'none'");
    expect(widgetEmbedOrigins({ active: false, allowed_origins: ["https://example.com"] }, [], app)).toEqual([]);
  });

  it("lists the widget's origins plus the instance itself", () => {
    expect(widgetFrameAncestors({ active: true, allowed_origins: ["https://example.com", "http://127.0.0.1:3101"] }, [], app)).toBe(
      "https://example.com http://127.0.0.1:3101 https://booking.example.com",
    );
  });

  it("uses the instance-wide fallback only when the widget lists no origins", () => {
    expect(widgetEmbedOrigins({ active: true, allowed_origins: [] }, ["https://example.org"], app)).toEqual(["https://example.org", app]);
    expect(widgetEmbedOrigins({ active: true, allowed_origins: null }, ["https://example.org"], app)).toEqual(["https://example.org", app]);
    expect(widgetEmbedOrigins({ active: true, allowed_origins: ["https://example.com"] }, ["https://example.org"], app)).toEqual(["https://example.com", app]);
    // Without either list only the instance itself (the playground) may frame it.
    expect(widgetFrameAncestors({ active: true, allowed_origins: [] }, [], app)).toBe(app);
  });

  it("drops anything that is not a plain origin, so no wildcard or extra directive can slip in", () => {
    const hostile = ["*", "https:", "'self'", "https://*.example.com", "https://example.com; script-src *", "https://example.com/path", "HTTPS://EXAMPLE.COM", "http://example.com"];
    expect(widgetFrameAncestors({ active: true, allowed_origins: hostile }, [], app)).toBe(app);
    expect(widgetFrameAncestors({ active: true, allowed_origins: [] }, hostile, app)).toBe(app);
  });

  it("deduplicates the instance origin", () => {
    expect(widgetEmbedOrigins({ active: true, allowed_origins: ["http://127.0.0.1:3100"] }, [], "http://127.0.0.1:3100")).toEqual(["http://127.0.0.1:3100"]);
  });
});

describe("embedOriginPattern", () => {
  it("matches the database rule embed_origins_valid", () => {
    for (const ok of ["https://example.com", "https://www.example.com:8443", "http://localhost", "http://127.0.0.1:3101", "https://a-b.example.co"]) expect(embedOriginPattern.test(ok)).toBe(true);
    for (const bad of ["https://localhost", "https://example", "http://example.com", "https://example.com/", "https://-a.example.com", "https://example.com:123456", "ftp://example.com"]) {
      expect(embedOriginPattern.test(bad)).toBe(false);
    }
  });
});

describe("widget paths", () => {
  it("builds window, section and confirmation paths", () => {
    expect(isWidgetId(id)).toBe(true);
    expect(isWidgetId("not-a-uuid")).toBe(false);
    expect(isWidgetId(undefined)).toBe(false);
    expect(widgetPath(id, "window")).toBe(`/widget/${id}`);
    expect(widgetPath(id, "section")).toBe(`/widget/${id}/section`);
    expect(widgetConfirmationPath(id, "window", "tok", true)).toBe(`/widget/${id}/confirmed/tok?new=1`);
    expect(widgetConfirmationPath(id, "section", "tok")).toBe(`/widget/${id}/section/confirmed/tok`);
  });
});
