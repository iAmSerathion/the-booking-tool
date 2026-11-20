import { describe, expect, it } from "vitest";
import { bookingLink, formatWindows, parseRules, parseWindows, windowsByDay } from "./settings";

describe("parseWindows", () => {
  it("parses, pads and sorts windows; empty means not bookable", () => {
    expect(parseWindows("14:00-17:00, 9:00 – 12:00")).toEqual({
      windows: [
        { start: "09:00", end: "12:00" },
        { start: "14:00", end: "17:00" },
      ],
    });
    expect(parseWindows("  ")).toEqual({ windows: [] });
    expect(parseWindows("09:00-12:00\n12:00-13:30")).toEqual({
      windows: [
        { start: "09:00", end: "12:00" },
        { start: "12:00", end: "13:30" },
      ],
    });
  });

  it("refuses bad formats, off-grid times, reversed and overlapping windows", () => {
    expect(parseWindows("9 to 12")).toEqual({ error: '"9 to 12" is not a time window like 09:00-12:00.' });
    expect(parseWindows("09:15-12:00")).toMatchObject({ error: expect.stringContaining("09:15") });
    expect(parseWindows("24:00-12:00")).toMatchObject({ error: expect.stringContaining("24:00") });
    expect(parseWindows("12:00-09:00")).toMatchObject({ error: expect.stringContaining("start must be before") });
    expect(parseWindows("12:00-12:00")).toMatchObject({ error: expect.stringContaining("start must be before") });
    expect(parseWindows("09:00-12:00, 11:30-13:00")).toEqual({ error: "09:00-12:00 and 11:30-13:00 overlap." });
  });

  it("round-trips through formatWindows", () => {
    const text = "09:00-12:00, 14:00-17:00";
    const parsed = parseWindows(text);
    expect("windows" in parsed && formatWindows(parsed.windows)).toBe(text);
  });
});

describe("windowsByDay", () => {
  it("groups database rows by ISO weekday and cuts seconds", () => {
    const days = windowsByDay([
      { weekday: 1, start_time: "14:00:00", end_time: "17:00:00" },
      { weekday: 1, start_time: "09:00:00", end_time: "12:00:00" },
      { weekday: 7, start_time: "10:00:00", end_time: "10:30:00" },
    ]);
    expect(days).toHaveLength(7);
    expect(days[0]).toEqual([
      { start: "09:00", end: "12:00" },
      { start: "14:00", end: "17:00" },
    ]);
    expect(days[6]).toEqual([{ start: "10:00", end: "10:30" }]);
    expect(days[2]).toEqual([]);
  });
});

describe("parseRules", () => {
  const zones = ["Europe/Berlin", "America/New_York"];
  const ok = { timezone: "Europe/Berlin", buffer_minutes: "15", min_notice_hours: "24", max_bookings_per_day: "3", meet_auto: "on" };

  it("accepts values inside the database ranges", () => {
    expect(parseRules(ok, zones)).toEqual({
      rules: { timezone: "Europe/Berlin", buffer_minutes: 15, min_notice_hours: 24, max_bookings_per_day: 3, meet_auto: true },
    });
    expect(parseRules({ ...ok, buffer_minutes: "0", min_notice_hours: "720", max_bookings_per_day: "20", meet_auto: null }, zones)).toMatchObject({
      rules: { buffer_minutes: 0, min_notice_hours: 720, max_bookings_per_day: 20, meet_auto: false },
    });
  });

  it("refuses unknown zones, out-of-range and non-integer numbers", () => {
    expect(parseRules({ ...ok, timezone: "Mars/Base" }, zones)).toEqual({ error: "Choose a time zone from the list." });
    expect(parseRules({ ...ok, buffer_minutes: "241" }, zones)).toEqual({ error: "Buffer between bookings must be a whole number from 0 to 240." });
    expect(parseRules({ ...ok, min_notice_hours: "-1" }, zones)).toMatchObject({ error: expect.stringContaining("Minimum notice") });
    expect(parseRules({ ...ok, max_bookings_per_day: "0" }, zones)).toMatchObject({ error: expect.stringContaining("from 1 to 20") });
    expect(parseRules({ ...ok, max_bookings_per_day: "2.5" }, zones)).toMatchObject({ error: expect.stringContaining("whole number") });
    expect(parseRules({ ...ok, buffer_minutes: null }, zones)).toMatchObject({ error: expect.stringContaining("Buffer") });
  });
});

describe("bookingLink", () => {
  it("builds the link from APP_URL, or nothing without a slug", () => {
    expect(bookingLink("https://book.example.com", "demo-host")).toBe("https://book.example.com/demo-host");
    expect(bookingLink("https://book.example.com", null)).toBeNull();
  });
});
