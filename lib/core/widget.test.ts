import { describe, expect, it } from "vitest";
import {
  cleanWidgetPage,
  embedOriginPattern,
  isWidgetId,
  parentOrigin,
  readWidgetBookingPage,
  readWidgetPrefill,
  widgetBookingPage,
  widgetConfirmationPath,
  widgetEmbedOrigins,
  widgetFrameAncestors,
  widgetMessage,
  widgetPath,
  widgetStepMessages,
} from "./widget";

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

describe("protocol v1", () => {
  it("builds messages with source, version and a clamped integer height", () => {
    expect(widgetMessage("ready")).toEqual({ source: "booking-widget", v: 1, type: "ready" });
    expect(widgetMessage("height", 512.4)).toEqual({ source: "booking-widget", v: 1, type: "height", height: 512 });
    expect(widgetMessage("height", -3)).toMatchObject({ height: 0 });
    expect(widgetMessage("height", 1e9)).toMatchObject({ height: 10_000 });
  });

  it("picks the parent origin only when the widget allows it", () => {
    const allowed = ["https://example.com", app];
    expect(parentOrigin(["https://example.com", null], allowed)).toBe("https://example.com");
    expect(parentOrigin([null, "https://example.com/pricing?x=1"], allowed)).toBe("https://example.com");
    expect(parentOrigin(["https://evil.example", "https://example.com/"], allowed)).toBe("https://example.com");
    expect(parentOrigin(["https://evil.example", "", "not a url"], allowed)).toBeNull();
    expect(parentOrigin(["https://example.com"], [])).toBeNull();
  });

  it("reads only a v1 prefill from the widget source and turns the answer pairs into a record, first id wins", () => {
    const base = { source: "booking-widget", v: 1, type: "prefill" };
    expect(readWidgetPrefill({ ...base, name: "Ada", email: "ada@example.com", company: "", topic: "Hi", answers: [{ id: "a", question: "ignored", answer: "x" }, { id: "a", answer: "y" }, { id: "m", answer: ["p", "q"] }, null, { id: 3 }] })).toEqual({
      name: "Ada",
      email: "ada@example.com",
      company: "",
      topic: "Hi",
      answers: { a: "x", m: ["p", "q"] },
    });
    expect(readWidgetPrefill({ ...base, answers: "nope" })?.answers).toEqual({});
    for (const data of [null, "prefill", { ...base, v: 2 }, { ...base, source: "other" }, { ...base, type: "ready" }]) expect(readWidgetPrefill(data)).toBeNull();
  });

  it("reports top on every step change and booked only from booking to its fresh confirmation", () => {
    expect(widgetStepMessages(null, { step: "booking", token: null })).toEqual({ top: false, booked: false });
    expect(widgetStepMessages({ step: "booking", token: null }, { step: "booking", token: null })).toEqual({ top: false, booked: false });
    expect(widgetStepMessages({ step: "booking", token: null }, { step: "booked", token: "t" })).toEqual({ top: true, booked: true });
    expect(widgetStepMessages({ step: "confirmed", token: "t" }, { step: "booked", token: "u" })).toEqual({ top: true, booked: false });
  });
});

describe("booking page", () => {
  it("cleans the host page path", () => {
    expect(cleanWidgetPage("/pricing/")).toBe("/pricing");
    expect(cleanWidgetPage("/")).toBe("/");
    expect(cleanWidgetPage("///")).toBe("/");
    for (const bad of ["pricing", "/p?x", "/ä", `/${"a".repeat(200)}`, 3, null]) expect(cleanWidgetPage(bad)).toBeNull();
  });

  it("builds the full link in the frame and accepts it on the server only for the widget's origins", () => {
    expect(widgetBookingPage("https://example.com", "/pricing/")).toBe("https://example.com/pricing");
    expect(widgetBookingPage(null, "/pricing")).toBeNull();
    expect(widgetBookingPage("https://example.com", "nope")).toBeNull();
    const allowed = ["https://example.com"];
    expect(readWidgetBookingPage("https://example.com/pricing", allowed)).toBe("https://example.com/pricing");
    for (const bad of ["https://evil.example/pricing", "https://example.com/pricing?x=1", "https://example.com/pricing#a", "https://u:p@example.com/", "https://example.com/a/", "https://EXAMPLE.com/a", "javascript:alert(1)", `https://example.com/${"a".repeat(300)}`, 1]) {
      expect(readWidgetBookingPage(bad, allowed), String(bad)).toBeNull();
    }
  });
});
