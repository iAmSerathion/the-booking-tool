import { describe, expect, it } from "vitest";
import { bookingChange, cancelReason, cancelReasonMaxLength } from "./change";

describe("bookingChange", () => {
  const now = new Date("2026-11-04T09:00:00Z");
  it("is open for a booked booking until its start", () => {
    expect(bookingChange({ state: "booked", startsAt: "2026-11-04T09:00:01Z" }, now)).toBe("open");
    expect(bookingChange({ state: "booked", startsAt: "2026-11-04T09:00:00Z" }, now)).toBe("past");
    expect(bookingChange({ state: "booked", startsAt: "2026-11-03T09:00:00Z" }, now)).toBe("past");
  });
  it("is cancelled for a cancelled booking, past or not", () => {
    expect(bookingChange({ state: "cancelled", startsAt: "2026-11-05T09:00:00Z" }, now)).toBe("cancelled");
    expect(bookingChange({ state: "cancelled", startsAt: "2026-11-03T09:00:00Z" }, now)).toBe("cancelled");
  });
});

describe("cancelReason", () => {
  it("trims, keeps line breaks, caps the length and turns empty into null", () => {
    expect(cancelReason("  Sick \r\n today  ")).toBe("Sick\ntoday");
    expect(cancelReason("   ")).toBeNull();
    expect(cancelReason(undefined)).toBeNull();
    expect(cancelReason(42)).toBeNull();
    expect(cancelReason("x".repeat(cancelReasonMaxLength + 50))).toHaveLength(cancelReasonMaxLength);
  });
});
