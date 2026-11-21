import { describe, expect, it } from "vitest";
import {
  bookableDays,
  calendarEventBlocks,
  freeSlots,
  isHolidayCalendar,
  isPublicHoliday,
  slotDayLabel,
  slotsByDay,
  type AvailabilityInput,
  type CalendarEvent,
  type Slot,
  withoutBooking,
} from "./availability";
import { zonedClock, zonedDay } from "./dates";
import { type TimeWindow, windowsByDay } from "./settings";

const berlin = "Europe/Berlin";
const dayWindows: TimeWindow[] = [
  { start: "09:00", end: "12:00" },
  { start: "14:00", end: "17:00" },
];

// Index 0 = Monday ... 6 = Sunday, like windowsByDay.
function week(days: Record<number, TimeWindow[]>): TimeWindow[][] {
  return Array.from({ length: 7 }, (_, i) => days[i] ?? []);
}

const workWeek = week({ 0: dayWindows, 1: dayWindows, 2: dayWindows, 3: dayWindows, 4: dayWindows });

// Monday, 2 November 2026, 08:00 in Berlin (winter time, UTC+1).
const monday = new Date("2026-11-02T07:00:00Z");

function input(overrides: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    windows: workWeek,
    timeZone: berlin,
    busy: [],
    bookings: [],
    durationMinutes: 45,
    bufferMinutes: 15,
    minNoticeHours: 0,
    maxBookingsPerDay: 3,
    horizonDays: 14,
    now: monday,
    ...overrides,
  };
}

// Start times of one day as HH:MM in the zone.
function times(slots: Slot[], day: string, timeZone = berlin): string[] {
  return slots.filter((slot) => zonedDay(slot.start, timeZone) === day).map((slot) => zonedClock(slot.start, timeZone));
}

const block = (start: string, end: string) => ({ start: new Date(start), end: new Date(end) });
const fullDay = ["09:00", "09:30", "10:00", "10:30", "11:00", "14:00", "14:30", "15:00", "15:30", "16:00"];

describe("free slots: windows and grid", () => {
  it("offers starts on the 30-minute grid with the whole booking inside the window", () => {
    expect(times(freeSlots(input()), "2026-11-02")).toEqual(fullDay);
  });

  it("a 60-minute type still fits up to 11:00 and 16:00", () => {
    expect(times(freeSlots(input({ durationMinutes: 60 })), "2026-11-02")).toEqual(fullDay);
  });

  it("a 15-minute type also starts only on the half hour", () => {
    const slots = freeSlots(input({ durationMinutes: 15, windows: week({ 0: [{ start: "09:00", end: "10:00" }] }) }));
    expect(times(slots, "2026-11-02")).toEqual(["09:00", "09:30"]);
  });

  it("a 480-minute type only fits a window of at least eight hours", () => {
    const slots = freeSlots(input({ durationMinutes: 480, windows: week({ 0: [{ start: "09:00", end: "17:00" }], 1: dayWindows }) }));
    expect(times(slots, "2026-11-02")).toEqual(["09:00"]);
    expect(times(slots, "2026-11-03")).toEqual([]);
  });

  it("a window the booking does not fit stays empty", () => {
    expect(times(freeSlots(input({ windows: week({ 0: [{ start: "09:00", end: "09:30" }] }) })), "2026-11-02")).toEqual([]);
  });

  it("days without windows are not bookable", () => {
    const slots = freeSlots(input());
    expect(times(slots, "2026-11-07")).toEqual([]);
    expect(times(slots, "2026-11-08")).toEqual([]);
  });

  it("uses windowsByDay rows by ISO weekday without shifting the day", () => {
    const windows = windowsByDay([{ weekday: 2, start_time: "10:00:00", end_time: "11:00:00" }]);
    const slots = freeSlots(input({ windows, durationMinutes: 30 }));
    expect(times(slots, "2026-11-02")).toEqual([]);
    expect(times(slots, "2026-11-03")).toEqual(["10:00", "10:30"]);
  });

  it("windows not starting on the half hour start at the next half hour", () => {
    expect(times(freeSlots(input({ windows: week({ 0: [{ start: "09:15", end: "11:00" }] }) })), "2026-11-02")).toEqual(["09:30", "10:00"]);
  });

  it("the end is the start plus the duration", () => {
    const [first] = freeSlots(input());
    expect(first.start.toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect(first.end.toISOString()).toBe("2026-11-02T08:45:00.000Z");
  });

  it("slots are sorted by start", () => {
    const starts = freeSlots(input()).map((slot) => slot.start.getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

describe("free slots: busy and buffer", () => {
  it("a Google event takes its time plus the buffer before and after", () => {
    // 10:00-10:30 in Berlin busy, 15 minutes buffer: 09:00 (ends 09:45) and from 11:00 stay free.
    const slots = freeSlots(input({ busy: [block("2026-11-02T09:00:00Z", "2026-11-02T09:30:00Z")] }));
    expect(times(slots, "2026-11-02").slice(0, 2)).toEqual(["09:00", "11:00"]);
  });

  it("without a buffer a booking fits right before and after", () => {
    const slots = freeSlots(input({ bufferMinutes: 0, busy: [block("2026-11-02T09:00:00Z", "2026-11-02T09:30:00Z")] }));
    expect(times(slots, "2026-11-02").slice(0, 3)).toEqual(["09:00", "10:30", "11:00"]);
  });

  it("a larger buffer takes more", () => {
    const slots = freeSlots(input({ bufferMinutes: 30, busy: [block("2026-11-02T09:00:00Z", "2026-11-02T09:30:00Z")] }));
    expect(times(slots, "2026-11-02").slice(0, 2)).toEqual(["11:00", "14:00"]);
  });

  it("an event over the whole day takes the day", () => {
    const slots = freeSlots(input({ busy: [block("2026-11-02T00:00:00Z", "2026-11-03T00:00:00Z")] }));
    expect(times(slots, "2026-11-02")).toEqual([]);
    expect(times(slots, "2026-11-03")).toHaveLength(10);
  });

  it("bookings in the tool are busy, with buffer", () => {
    // 14:00-14:45 booked: 14:00 and 14:30 gone, 15:00 (buffer until 15:00) free.
    const slots = freeSlots(input({ bookings: [block("2026-11-02T13:00:00Z", "2026-11-02T13:45:00Z")] }));
    expect(times(slots, "2026-11-02").slice(5)).toEqual(["15:00", "15:30", "16:00"]);
  });
});

describe("free slots: earliest and latest", () => {
  it("not before now plus the minimum notice", () => {
    // Monday 08:00 plus 24 hours: from Tuesday 08:00, so from 09:00.
    const slots = freeSlots(input({ minNoticeHours: 24 }));
    expect(times(slots, "2026-11-02")).toEqual([]);
    expect(times(slots, "2026-11-03")[0]).toBe("09:00");
  });

  it("the notice cuts in the middle of a day without rounding", () => {
    // Monday 10:10 plus 24 hours: Tuesday from 10:30.
    expect(times(freeSlots(input({ minNoticeHours: 24, now: new Date("2026-11-02T09:10:00Z") })), "2026-11-03")[0]).toBe("10:30");
  });

  it("without notice nothing in the past", () => {
    expect(times(freeSlots(input({ now: new Date("2026-11-02T09:10:00Z") })), "2026-11-02")[0]).toBe("10:30");
  });

  it("nothing beyond the horizon: the last day is today plus 14", () => {
    const slots = freeSlots(input());
    expect(times(slots, "2026-11-16")).toHaveLength(10);
    expect(times(slots, "2026-11-17")).toEqual([]);
    expect(slots.every((slot) => slot.start < new Date("2026-11-17T00:00:00+01:00"))).toBe(true);
  });

  it("the horizon is configurable", () => {
    const slots = freeSlots(input({ horizonDays: 7 }));
    expect(times(slots, "2026-11-09")).toHaveLength(10);
    expect(times(slots, "2026-11-10")).toEqual([]);
  });

  it("bookable days count in the host's zone", () => {
    // 23:30 UTC on Sunday is already Monday in Berlin.
    expect(bookableDays(new Date("2026-11-01T23:30:00Z"), berlin, 2)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
  });
});

describe("free slots: maximum per day", () => {
  const bookings = [
    block("2026-11-02T08:00:00Z", "2026-11-02T08:45:00Z"),
    block("2026-11-02T10:00:00Z", "2026-11-02T11:00:00Z"),
    block("2026-11-02T15:00:00Z", "2026-11-02T15:45:00Z"),
  ];

  it("a day that reached the maximum is full", () => {
    const slots = freeSlots(input({ bookings }));
    expect(times(slots, "2026-11-02")).toEqual([]);
    expect(times(slots, "2026-11-03")).toHaveLength(10);
  });

  it("below it, the times around the bookings stay free", () => {
    // Bookings 09:00-09:45 and 11:00-12:00 in Berlin, 15 minutes buffer: 10:00 just fits between.
    expect(times(freeSlots(input({ bookings: bookings.slice(0, 2) })), "2026-11-02")).toEqual(["10:00", "14:00", "14:30", "15:00", "15:30", "16:00"]);
  });

  it("Google events do not count toward the maximum", () => {
    expect(times(freeSlots(input({ busy: bookings })), "2026-11-02")).toEqual(["10:00", "14:00", "14:30", "15:00"]);
  });

  it("counts by the day in the host's zone", () => {
    // 23:30 UTC on Monday is Tuesday 00:30 in Berlin.
    const late = block("2026-11-02T23:30:00Z", "2026-11-03T00:15:00Z");
    const slots = freeSlots(input({ maxBookingsPerDay: 1, bookings: [late] }));
    expect(times(slots, "2026-11-02")).toHaveLength(10);
    expect(times(slots, "2026-11-03")).toEqual([]);
  });
});

describe("free slots: daylight saving time", () => {
  it("09:00 in Berlin stays 09:00 across the change to winter time", () => {
    // Friday, 29 October 2027, 08:00 in Berlin (summer time). The change is on Sunday, 31 October.
    const slots = freeSlots(input({ now: new Date("2027-10-29T06:00:00Z") }));
    const friday = slots.find((slot) => zonedDay(slot.start, berlin) === "2027-10-29")!;
    const nextMonday = slots.find((slot) => zonedDay(slot.start, berlin) === "2027-11-01")!;
    expect(friday.start.toISOString()).toBe("2027-10-29T07:00:00.000Z");
    expect(nextMonday.start.toISOString()).toBe("2027-11-01T08:00:00.000Z");
    expect(times(slots, "2027-11-01")).toEqual(times(slots, "2027-10-29"));
  });

  it("and across the change to summer time", () => {
    const slots = freeSlots(input({ now: new Date("2027-03-26T07:00:00Z") }));
    expect(slots.find((slot) => zonedDay(slot.start, berlin) === "2027-03-26")!.start.toISOString()).toBe("2027-03-26T08:00:00.000Z");
    expect(slots.find((slot) => zonedDay(slot.start, berlin) === "2027-03-29")!.start.toISOString()).toBe("2027-03-29T07:00:00.000Z");
  });

  it("the horizon counts calendar days across the change", () => {
    const slots = freeSlots(input({ now: new Date("2027-10-25T06:00:00Z") }));
    expect(times(slots, "2027-11-08")).toHaveLength(10);
    expect(times(slots, "2027-11-09")).toEqual([]);
  });

  it("on the night clocks spring forward, 02:00 and 02:30 are skipped and a booking lasts a real 60 minutes", () => {
    // Sunday, 28 March 2027: at 02:00 the clock jumps to 03:00.
    const slots = freeSlots(input({ now: new Date("2027-03-27T12:00:00Z"), durationMinutes: 60, windows: week({ 6: [{ start: "01:00", end: "05:00" }] }) }));
    expect(times(slots, "2027-03-28")).toEqual(["01:00", "01:30", "03:00", "03:30", "04:00"]);
    expect(slots.every((slot) => slot.end.getTime() - slot.start.getTime() === 60 * 60_000)).toBe(true);
  });

  it("a window ending in the skipped hour falls back to wall-clock minutes", () => {
    const slots = freeSlots(input({ now: new Date("2027-03-27T12:00:00Z"), durationMinutes: 30, windows: week({ 6: [{ start: "01:00", end: "02:30" }] }) }));
    expect(times(slots, "2027-03-28")).toEqual(["01:00", "01:30"]);
  });

  it("on the night clocks fall back, 02:00 and 02:30 appear once", () => {
    // Sunday, 31 October 2027: at 03:00 the clock goes back to 02:00.
    const slots = freeSlots(input({ now: new Date("2027-10-30T12:00:00Z"), durationMinutes: 30, windows: week({ 6: [{ start: "01:00", end: "04:00" }] }) }));
    expect(times(slots, "2027-10-31")).toEqual(["01:00", "01:30", "02:00", "02:30", "03:00", "03:30"]);
  });

  it("windows apply in the host's zone", () => {
    // New York changes to winter time on 1 November 2026: 09:00 is 13:00 UTC before and 14:00 UTC after.
    const ny = "America/New_York";
    const slots = freeSlots(input({ timeZone: ny, now: new Date("2026-10-29T12:00:00Z") }));
    expect(slots.find((slot) => zonedDay(slot.start, ny) === "2026-10-30")!.start.toISOString()).toBe("2026-10-30T13:00:00.000Z");
    expect(slots.find((slot) => zonedDay(slot.start, ny) === "2026-11-02")!.start.toISOString()).toBe("2026-11-02T14:00:00.000Z");
    expect(times(slots, "2026-11-02", ny)[0]).toBe("09:00");
  });
});

describe("preview of the host's times", () => {
  it("shows every bookable day with windows, also without a free time", () => {
    const base = input({ minNoticeHours: 24 });
    const days = slotsByDay(freeSlots(base), base);
    expect(days[0]).toEqual({ day: "2026-11-02", times: [] });
    expect(days[1].times[0]).toBe("09:00");
    expect(days.map((day) => day.day)).not.toContain("2026-11-07");
    expect(days.at(-1)!.day).toBe("2026-11-16");
    expect(days).toHaveLength(11);
  });

  it("labels days short in the locale", () => {
    expect(slotDayLabel("2026-11-02", "de")).toBe("Mo., 2. Nov.");
    expect(slotDayLabel("2027-03-28", "de")).toBe("So., 28. März");
    expect(slotDayLabel("2026-11-02", "en")).toBe("Mon, Nov 2");
  });
});

describe("extra calendars: also events marked free and all-day events", () => {
  const holidays = "en.usa#holiday@group.v.calendar.google.com";
  const timetable = "timetable@group.calendar.google.com";
  const allDay = (start: string, end: string, more: Partial<CalendarEvent> = {}): CalendarEvent => ({ status: "confirmed", start: { date: start }, end: { date: end }, ...more });
  const holiday = (day: string, end: string, description: string) => allDay(day, end, { description });

  it("recognises Google's holiday calendars", () => {
    expect(isHolidayCalendar(holidays)).toBe(true);
    expect(isHolidayCalendar("de.german.official#holiday@group.v.calendar.google.com")).toBe(true);
    expect(isHolidayCalendar(timetable)).toBe(false);
    expect(isHolidayCalendar("host@example.com")).toBe(false);
  });

  it("public is what Google marks as a public holiday in German or English, also half days", () => {
    expect(isPublicHoliday({ description: "Public holiday" })).toBe(true);
    expect(isPublicHoliday({ description: "Gesetzlicher Feiertag" })).toBe(true);
    expect(isPublicHoliday({ description: "Gesetzlicher Feiertag\nHalbtägiger Feiertag" })).toBe(true);
    expect(isPublicHoliday({ description: "Observance\nTo hide observances, go to Google Calendar Settings" })).toBe(false);
    expect(isPublicHoliday({ description: "Common local holiday" })).toBe(false);
    expect(isPublicHoliday({})).toBe(false);
  });

  it("a public holiday blocks the whole day in the host's zone", () => {
    expect(calendarEventBlocks(holidays, [holiday("2026-12-25", "2026-12-26", "Public holiday")], berlin)).toEqual([
      block("2026-12-24T23:00:00Z", "2026-12-25T23:00:00Z"),
    ]);
    expect(calendarEventBlocks(holidays, [holiday("2026-12-25", "2026-12-26", "Public holiday")], "America/New_York")).toEqual([
      block("2026-12-25T05:00:00Z", "2026-12-26T05:00:00Z"),
    ]);
  });

  it("observances and regional holidays do not block", () => {
    const blocks = calendarEventBlocks(
      holidays,
      [
        holiday("2026-11-11", "2026-11-12", "Observance"),
        holiday("2026-11-18", "2026-11-19", "Common local holiday"),
        holiday("2026-12-31", "2027-01-01", "Public holiday\nHalf day"),
        holiday("2027-01-01", "2027-01-02", "Public holiday"),
      ],
      berlin,
    );
    expect(blocks).toEqual([block("2026-12-30T23:00:00Z", "2026-12-31T23:00:00Z"), block("2026-12-31T23:00:00Z", "2027-01-01T23:00:00Z")]);
  });

  it("in other calendars every event counts, also marked free and over several days", () => {
    const blocks = calendarEventBlocks(
      timetable,
      [
        { status: "confirmed", start: { dateTime: "2026-11-03T09:00:00Z" }, end: { dateTime: "2026-11-03T10:45:00Z" } },
        allDay("2026-11-09", "2026-11-11", { description: "Observance" }),
      ],
      berlin,
    );
    expect(blocks).toEqual([block("2026-11-03T09:00:00Z", "2026-11-03T10:45:00Z"), block("2026-11-08T23:00:00Z", "2026-11-10T23:00:00Z")]);
  });

  it("cancelled and declined events and working locations do not count", () => {
    const timed = { start: { dateTime: "2026-11-03T09:00:00Z" }, end: { dateTime: "2026-11-03T10:00:00Z" } };
    const blocks = calendarEventBlocks(
      timetable,
      [
        { ...timed, status: "cancelled" },
        { ...timed, status: "confirmed", attendees: [{ self: true, responseStatus: "declined" }] },
        { ...allDay("2026-11-04", "2026-11-05"), eventType: "workingLocation" },
        { ...timed, status: "confirmed", attendees: [{ self: true, responseStatus: "accepted" }, { responseStatus: "declined" }] },
        { status: "confirmed", start: { dateTime: "2026-11-03T10:00:00Z" }, end: { dateTime: "2026-11-03T10:00:00Z" } },
      ],
      berlin,
    );
    expect(blocks).toEqual([block("2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z")]);
  });

  it("an all-day event on the day clocks spring forward lasts 23 hours", () => {
    expect(calendarEventBlocks(timetable, [allDay("2027-03-28", "2027-03-29")], berlin)).toEqual([block("2027-03-27T23:00:00Z", "2027-03-28T22:00:00Z")]);
  });

  it("an all-day event starts at 01:00 where midnight does not exist", () => {
    expect(calendarEventBlocks(timetable, [allDay("2026-09-06", "2026-09-07")], "America/Santiago")).toEqual([
      block("2026-09-06T04:00:00Z", "2026-09-07T03:00:00Z"),
    ]);
  });

  it("a public holiday has no free times, the day before has", () => {
    const busy = calendarEventBlocks(holidays, [holiday("2026-11-05", "2026-11-06", "Public holiday")], berlin);
    const slots = freeSlots(input({ busy }));
    expect(times(slots, "2026-11-05")).toEqual([]);
    expect(times(slots, "2026-11-04")[0]).toBe("09:00");
    expect(times(slots, "2026-11-04").at(-1)).toBe("16:00");
  });
});

describe("rescheduling: the booking being moved does not block itself", () => {
  // The own booking 09:00-09:45 Berlin, as both a Google busy block and a tool booking; two more bookings fill the day.
  const own = block("2026-11-02T08:00:00Z", "2026-11-02T08:45:00Z");
  const others = [block("2026-11-02T13:00:00Z", "2026-11-02T13:45:00Z"), block("2026-11-02T15:00:00Z", "2026-11-02T15:45:00Z")];

  it("frees its neighbours (buffer) and does not count toward the daily maximum", () => {
    const full = input({ busy: [own, ...others], bookings: [own, ...others] });
    expect(times(freeSlots(full), "2026-11-02")).toEqual([]);
    expect(times(freeSlots(withoutBooking(full, own)), "2026-11-02")).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "15:00"]);
  });

  it("cuts only its own interval out of a larger busy block", () => {
    const meeting = block("2026-11-02T07:30:00Z", "2026-11-02T09:30:00Z");
    expect(withoutBooking({ busy: [meeting], bookings: [] }, own).busy).toEqual([
      block("2026-11-02T07:30:00Z", "2026-11-02T08:00:00Z"),
      block("2026-11-02T08:45:00Z", "2026-11-02T09:30:00Z"),
    ]);
    expect(withoutBooking({ busy: [others[0]], bookings: [] }, own).busy).toEqual([others[0]]);
  });

  it("drops exactly one booking with its times", () => {
    expect(withoutBooking({ busy: [], bookings: [own, own, others[0]] }, own).bookings).toEqual([own, others[0]]);
  });
});
