import { describe, expect, it } from "vitest";
import {
  alreadyBookedText,
  calendarMonths,
  cleanBookingInput,
  dayTitle,
  formatTime,
  looksLikeBot,
  roundRobinOrder,
  roundRobinPick,
  slotChip,
  slotLong,
  slotsByCustomerDay,
  timeZoneLabel,
  validateBooking,
} from "./booking";

// Intl puts a narrow no-break space before AM/PM; tests compare with plain spaces.
const plain = (text: string) => text.replace(/[\u202f\u00a0]/g, " ");

describe("round robin", () => {
  it("takes the host without a booking first, otherwise the oldest last booking", () => {
    const a = { id: "a", name: "Alex", lastBookingAt: "2026-10-20T10:00:00Z" };
    expect(roundRobinPick([a, { id: "b", name: "Blair", lastBookingAt: null }])).toBe("b");
    expect(roundRobinPick([a, { id: "b", name: "Blair", lastBookingAt: "2026-10-21T10:00:00Z" }])).toBe("a");
    expect(roundRobinPick([])).toBeNull();
  });

  it("returns the full order, ties by name and then by id", () => {
    expect(
      roundRobinOrder([
        { id: "3", name: "Casey", lastBookingAt: "2026-10-22T10:00:00Z" },
        { id: "2", name: "Blair", lastBookingAt: null },
        { id: "9", name: "Alex", lastBookingAt: null },
        { id: "1", name: "Alex", lastBookingAt: null },
      ]),
    ).toEqual(["1", "9", "2", "3"]);
  });
});

describe("invitee details", () => {
  const ok = cleanBookingInput({ name: "Robin Example", email: "robin@example.com", privacy: "on" });

  it("cleans and caps the fields", () => {
    expect(cleanBookingInput({ name: "  Robin\u200b  Example ", email: " robin@example.com ", phone: 5, topic: "a\r\n\r\n\r\nb", privacy: true })).toEqual({
      name: "Robin Example",
      email: "robin@example.com",
      company: "",
      phone: "",
      topic: "a\n\nb",
      privacy: true,
    });
    expect(cleanBookingInput({ name: "x".repeat(500) }).name).toHaveLength(200);
    expect(cleanBookingInput({ privacy: "yes" }).privacy).toBe(false);
  });

  it("requires name and a complete email; company, phone and topic are optional", () => {
    expect(validateBooking(ok, { privacyRequired: true })).toEqual({});
    expect(validateBooking({ ...ok, name: "", email: "" }, { privacyRequired: false })).toEqual({ name: "booking.error.name", email: "booking.error.email" });
    for (const email of ["robin@", "robin@example", "robin example@example.com", "a@b.c,d@e.f"]) {
      expect(validateBooking({ ...ok, email }, { privacyRequired: false })).toEqual({ email: "booking.error.emailInvalid" });
    }
  });

  it("requires the privacy box only when there is a privacy notice", () => {
    expect(validateBooking({ ...ok, privacy: false }, { privacyRequired: true })).toEqual({ privacy: "booking.error.privacy" });
    expect(validateBooking({ ...ok, privacy: false }, { privacyRequired: false })).toEqual({});
  });
});

describe("bot check", () => {
  it("catches the filled hidden field, a fast submit and a forged start", () => {
    expect(looksLikeBot({ honeypot: "", startedAt: 0, now: 10_000 })).toBe(false);
    expect(looksLikeBot({ honeypot: "", startedAt: 7_000, now: 10_000 })).toBe(false);
    expect(looksLikeBot({ honeypot: "https://spam.example.com", startedAt: 0, now: 10_000 })).toBe(true);
    expect(looksLikeBot({ honeypot: "", startedAt: 9_000, now: 10_000 })).toBe(true);
    expect(looksLikeBot({ honeypot: "", startedAt: 20_000, now: 10_000 })).toBe(true);
    expect(looksLikeBot({ honeypot: "", startedAt: Number.NaN, now: 10_000 })).toBe(true);
  });
});

describe("times in the invitee's zone and locale", () => {
  const start = new Date("2026-11-04T09:30:00.000Z");
  const end = new Date("2026-11-04T10:15:00.000Z");

  it("German texts", () => {
    expect(slotChip(start, end, "Europe/Berlin", "de")).toBe("Mi., 4. Nov., 10:30 bis 11:15");
    expect(slotLong(start, end, "Europe/Berlin", "de")).toBe("Mittwoch, 4. November 2026, 10:30 bis 11:15");
    expect(dayTitle("2026-11-04", "de")).toBe("Mittwoch, 4. November");
    expect(alreadyBookedText(start, "Europe/Berlin", "de")).toBe("Du hast schon einen Termin am Mittwoch, 4. November um 10:30.");
  });

  it("English texts", () => {
    expect(plain(slotChip(start, end, "Europe/Berlin", "en"))).toBe("Wed, Nov 4, 10:30 AM to 11:15 AM");
    expect(plain(slotLong(start, end, "Europe/Berlin", "en"))).toBe("Wednesday, November 4, 2026, 10:30 AM to 11:15 AM");
    expect(dayTitle("2026-11-04", "en")).toBe("Wednesday, November 4");
    expect(plain(alreadyBookedText(start, "Europe/Berlin", "en"))).toBe("You already have a booking on Wednesday, November 4 at 10:30 AM.");
  });

  it("shows the same instant in another zone, also across midnight", () => {
    expect(slotChip(start, end, "America/New_York", "de")).toBe("Mi., 4. Nov., 04:30 bis 05:15");
    expect(plain(formatTime(start, "America/New_York", "en"))).toBe("4:30 AM");
    const late = new Date("2026-11-04T23:30:00.000Z");
    expect([...slotsByCustomerDay([late.toISOString()], "Europe/Berlin").keys()]).toEqual(["2026-11-05"]);
    expect([...slotsByCustomerDay([late.toISOString()], "America/New_York").keys()]).toEqual(["2026-11-04"]);
  });

  it("groups starts by day, earliest first", () => {
    const days = slotsByCustomerDay(["2026-11-04T13:00:00.000Z", "2026-11-04T08:00:00.000Z", "2026-11-05T08:00:00.000Z"], "Europe/Berlin");
    expect([...days.entries()]).toEqual([
      ["2026-11-04", ["2026-11-04T08:00:00.000Z", "2026-11-04T13:00:00.000Z"]],
      ["2026-11-05", ["2026-11-05T08:00:00.000Z"]],
    ]);
  });

  it("time zone label follows DST", () => {
    expect(timeZoneLabel("Europe/Berlin", start, "de")).toBe("Europe/Berlin (MEZ)");
    expect(timeZoneLabel("Europe/Berlin", new Date("2026-07-01T10:00:00Z"), "de")).toBe("Europe/Berlin (MESZ)");
    expect(timeZoneLabel("Europe/Berlin", start, "en")).toBe("Europe/Berlin (GMT+1)");
  });

  it("the calendar shows every month from the first to the last free day", () => {
    expect(calendarMonths(["2026-11-30", "2026-12-02"], "2026-11-29")).toEqual([
      [2026, 11],
      [2026, 12],
    ]);
    expect(calendarMonths(["2026-12-30", "2027-01-04"], "2026-12-29")).toEqual([
      [2026, 12],
      [2027, 1],
    ]);
    expect(calendarMonths([], "2026-11-03")).toEqual([[2026, 11]]);
  });
});
