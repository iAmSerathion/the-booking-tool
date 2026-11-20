import { describe, expect, it } from "vitest";
import { addDays, dayStart, safeTimeZone, weekday, zonedClock, zonedDay, zonedTime } from "./dates";

const berlin = "Europe/Berlin";

describe("zonedDay and zonedClock", () => {
  it("give the day and time in the zone, not on the server", () => {
    const late = new Date("2026-11-02T23:30:00Z");
    expect(zonedDay(late, "UTC")).toBe("2026-11-02");
    expect(zonedDay(late, berlin)).toBe("2026-11-03");
    expect(zonedClock(late, berlin)).toBe("00:30");
    expect(zonedDay(late, "America/New_York")).toBe("2026-11-02");
    expect(zonedClock(late, "America/New_York")).toBe("18:30");
  });

  it("never shows 24:00 at midnight", () => {
    expect(zonedClock(new Date("2026-11-02T23:00:00Z"), berlin)).toBe("00:00");
  });

  it("throw for an unknown zone", () => {
    expect(() => zonedDay(new Date(), "Mars/Base")).toThrow(RangeError);
  });
});

describe("zonedTime", () => {
  it("finds the instant in winter and summer time", () => {
    expect(zonedTime("2026-11-02", 9, 0, berlin)?.toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect(zonedTime("2026-07-01", 9, 0, berlin)?.toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(zonedTime("2026-07-01", 9, 0, "UTC")?.toISOString()).toBe("2026-07-01T09:00:00.000Z");
  });

  it("gives null for a time skipped when clocks spring forward", () => {
    // Sunday, 28 March 2027: 02:00 jumps to 03:00 in Berlin.
    expect(zonedTime("2027-03-28", 2, 0, berlin)).toBeNull();
    expect(zonedTime("2027-03-28", 2, 30, berlin)).toBeNull();
    expect(zonedTime("2027-03-28", 3, 0, berlin)?.toISOString()).toBe("2027-03-28T01:00:00.000Z");
  });

  it("gives the first occurrence of a time repeated when clocks fall back", () => {
    // Sunday, 31 October 2027: 03:00 goes back to 02:00 in Berlin, so 02:30 happens twice.
    expect(zonedTime("2027-10-31", 2, 30, berlin)?.toISOString()).toBe("2027-10-31T00:30:00.000Z");
  });

  it("handles a zone west of UTC", () => {
    expect(zonedTime("2026-10-30", 9, 0, "America/New_York")?.toISOString()).toBe("2026-10-30T13:00:00.000Z");
    expect(zonedTime("2026-11-02", 9, 0, "America/New_York")?.toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });
});

describe("dayStart", () => {
  it("is midnight on a normal day", () => {
    expect(dayStart("2026-12-25", berlin)?.toISOString()).toBe("2026-12-24T23:00:00.000Z");
  });

  it("falls back to 01:00 where clocks change at midnight", () => {
    // Santiago springs forward at 00:00 on Sunday, 6 September 2026: the day starts at 01:00 (UTC-3).
    expect(zonedTime("2026-09-06", 0, 0, "America/Santiago")).toBeNull();
    expect(dayStart("2026-09-06", "America/Santiago")?.toISOString()).toBe("2026-09-06T04:00:00.000Z");
  });
});

describe("addDays and weekday", () => {
  it("count calendar days across months, years and DST", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-03-27", 2)).toBe("2027-03-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("weekday is 0 for Monday and 6 for Sunday", () => {
    expect(weekday("2026-11-02")).toBe(0);
    expect(weekday("2026-11-08")).toBe(6);
  });
});

describe("safeTimeZone", () => {
  it("keeps a valid zone in canonical form and falls back otherwise", () => {
    expect(safeTimeZone("America/New_York", berlin)).toBe("America/New_York");
    expect(safeTimeZone("europe/berlin", "UTC")).toBe("Europe/Berlin");
    for (const value of ["Mars/Base", "", null, 5, "x".repeat(100)]) expect(safeTimeZone(value, berlin)).toBe(berlin);
  });
});
