import { addDays, dayStart, weekday, zonedClock, zonedDay, zonedTime } from "./dates";
import type { TimeWindow } from "./settings";

// Free slots: when an invitee can book a host. Pure, no database and no Google.

export type TimeBlock = { start: Date; end: Date };
export type Slot = TimeBlock;

export type AvailabilityInput = {
  // When the host is bookable, as local times in their zone: windowsByDay from lib/core/settings.ts, index 0 = Monday.
  windows: TimeWindow[][];
  timeZone: string;
  // Busy times that block slots but do not count toward the daily maximum: Google free/busy, events of the extra
  // calendars (calendarEventBlocks) and live slot holds.
  busy: TimeBlock[];
  // The host's booked bookings in this tool: busy, and counted for the daily maximum.
  bookings: TimeBlock[];
  durationMinutes: number;
  bufferMinutes: number;
  minNoticeHours: number;
  maxBookingsPerDay: number;
  // The last bookable day is today plus this many calendar days, in the host's zone.
  horizonDays: number;
  now: Date;
};

const minute = 60_000;
// Fixed for every event type: a 15-minute type also starts on :00 and :30 only. Windows are on the same grid (DB check).
export const slotStepMinutes = 30;

// Events of the extra busy calendars ---------------------------------------------------------------------------------
// Google free/busy skips events marked "free", and Google lists every holiday that way. For the extra calendars the tool
// therefore reads the events itself; the primary calendar stays on free/busy (otherwise working locations or birthdays
// would block whole days).

export type CalendarEvent = {
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  description?: string;
  eventType?: string;
  attendees?: { self?: boolean; responseStatus?: string }[];
};

// Google's holiday calendars, e.g. "en.usa#holiday@group.v.calendar.google.com".
export function isHolidayCalendar(calendarId: string): boolean {
  return calendarId.toLowerCase().endsWith("#holiday@group.v.calendar.google.com");
}

// A public holiday as Google marks it: the first line of the description. Google writes it in the calendar's language;
// only German and English are recognised, so in other languages a holiday calendar blocks nothing (a known limit).
// Observances and regional holidays have other first lines and do not block.
export function isPublicHoliday(event: Pick<CalendarEvent, "description">): boolean {
  const first = (event.description ?? "").split("\n")[0].trim().toLowerCase();
  return first === "gesetzlicher feiertag" || first === "public holiday";
}

const isoDay = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);

// Busy blocks from an extra calendar's events: every event, also those marked "free"; all-day events block their days
// in the host's zone. Cancelled and declined events and working locations do not count; in a holiday calendar only
// public holidays do.
export function calendarEventBlocks(calendarId: string, events: readonly CalendarEvent[], timeZone: string): TimeBlock[] {
  const holidays = isHolidayCalendar(calendarId);
  const blocks: TimeBlock[] = [];
  for (const event of events) {
    if (event.status === "cancelled" || event.eventType === "workingLocation") continue;
    if (event.attendees?.some((attendee) => attendee.self && attendee.responseStatus === "declined")) continue;
    if (holidays && !isPublicHoliday(event)) continue;
    const startDay = event.start?.dateTime ? null : isoDay(event.start?.date);
    if (startDay) {
      const endDay = isoDay(event.end?.date);
      const start = dayStart(startDay, timeZone);
      const end = dayStart(endDay && endDay > startDay ? endDay : addDays(startDay, 1), timeZone);
      if (start && end) blocks.push({ start, end });
      continue;
    }
    const start = new Date(event.start?.dateTime ?? Number.NaN);
    const end = new Date(event.end?.dateTime ?? Number.NaN);
    if (end.getTime() > start.getTime()) blocks.push({ start, end });
  }
  return blocks;
}

const clockMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

// The days from today to the last bookable day, in the host's zone (calendar days, so DST does not shift them).
export function bookableDays(now: Date, timeZone: string, horizonDays: number): string[] {
  const today = zonedDay(now, timeZone);
  return Array.from({ length: horizonDays + 1 }, (_, i) => addDays(today, i));
}

export function freeSlots(input: AvailabilityInput): Slot[] {
  const { timeZone, durationMinutes } = input;
  const earliest = input.now.getTime() + input.minNoticeHours * 60 * minute;
  const duration = durationMinutes * minute;
  const buffer = input.bufferMinutes * minute;
  // Buffer before and after every busy block, Google events included. Half-open intervals: back to back fits.
  const blocked = [...input.busy, ...input.bookings].map((block) => ({ start: block.start.getTime() - buffer, end: block.end.getTime() + buffer }));

  // Only bookings in this tool count toward the maximum, by the host-local day of their start.
  const perDay = new Map<string, number>();
  for (const booking of input.bookings) {
    const day = zonedDay(booking.start, timeZone);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }

  const slots: Slot[] = [];
  for (const day of bookableDays(input.now, timeZone, input.horizonDays)) {
    if ((perDay.get(day) ?? 0) >= input.maxBookingsPerDay) continue;
    for (const window of input.windows[weekday(day)] ?? []) {
      const windowEnd = clockMinutes(window.end);
      const endOfWindow = zonedTime(day, Math.floor(windowEnd / 60), windowEnd % 60, timeZone);
      const first = Math.ceil(clockMinutes(window.start) / slotStepMinutes) * slotStepMinutes;
      for (let local = first; local < windowEnd; local += slotStepMinutes) {
        const start = zonedTime(day, Math.floor(local / 60), local % 60, timeZone);
        if (!start) continue; // skipped by a DST change
        // Real milliseconds, so a slot is always truly durationMinutes long, also across a DST change.
        const end = start.getTime() + duration;
        // The whole slot inside the window; if the window end itself does not exist that day, compare wall-clock minutes.
        if (endOfWindow ? end > endOfWindow.getTime() : local + durationMinutes > windowEnd) continue;
        if (start.getTime() < earliest) continue;
        if (blocked.some((block) => block.start < end && block.end > start.getTime())) continue;
        slots.push({ start, end: new Date(end) });
      }
    }
  }
  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}

// Preview "how invitees see my times" ---------------------------------------------------------------------------------

export type SlotDay = { day: string; times: string[] };

// Per bookable day with windows, the start times as HH:MM in the host's zone; days without windows are left out.
export function slotsByDay(slots: Slot[], input: Pick<AvailabilityInput, "windows" | "timeZone" | "horizonDays" | "now">): SlotDay[] {
  return bookableDays(input.now, input.timeZone, input.horizonDays)
    .filter((day) => (input.windows[weekday(day)] ?? []).length > 0)
    .map((day) => ({
      day,
      times: slots.filter((slot) => zonedDay(slot.start, input.timeZone) === day).map((slot) => zonedClock(slot.start, input.timeZone)),
    }));
}

// Short day label such as "Mo., 2. Nov." (de) or "Mon, Nov 2" (en). Days are formatted at noon UTC, so any zone is fine.
export function slotDayLabel(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${day}T12:00:00Z`));
}
