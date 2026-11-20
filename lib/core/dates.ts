// Calendar days and wall-clock times in any IANA time zone, independent of the server's own zone. Pure; the instance
// default zone (DEFAULT_TIMEZONE) comes from lib/config.ts and is passed in by the caller.
// Days are "YYYY-MM-DD" strings; times are "HH:MM".

const partsFormats = new Map<string, Intl.DateTimeFormat>();

// Throws a RangeError for an unknown time zone, like Intl itself.
function partsFormat(timeZone: string): Intl.DateTimeFormat {
  let format = partsFormats.get(timeZone);
  if (!format) {
    // en-CA with h23: numeric parts and never "24:00".
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    partsFormats.set(timeZone, format);
  }
  return format;
}

function zonedParts(at: Date, timeZone: string) {
  const parts = Object.fromEntries(partsFormat(timeZone).formatToParts(at).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
}

const pad = (n: number) => String(n).padStart(2, "0");

// The calendar day of an instant in a time zone.
export function zonedDay(at: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(at, timeZone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

// The wall-clock time of an instant in a time zone.
export function zonedClock(at: Date, timeZone: string): string {
  const { hour, minute } = zonedParts(at, timeZone);
  return `${pad(hour)}:${pad(minute)}`;
}

// The instant of a wall-clock time on a day in a time zone, across DST changes.
// A time that does not exist that day (clocks spring forward) gives null; a time that exists twice (clocks fall back)
// gives the first, earlier occurrence.
export function zonedTime(day: string, hour: number, minute: number, timeZone: string): Date | null {
  const [y, m, d] = day.split("-").map(Number);
  const wanted = Date.UTC(y, m - 1, d, hour, minute);
  const shown = (at: number) => {
    const p = zonedParts(new Date(at), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  };
  // The zone's offset a day before and a day after; try both candidates, the earlier first.
  const candidates = [wanted - 86_400_000, wanted + 86_400_000].map((probe) => wanted - (shown(probe) - probe)).sort((a, b) => a - b);
  for (const candidate of candidates) if (shown(candidate) === wanted) return new Date(candidate);
  return null;
}

// Start of a calendar day. In zones that change clocks at midnight the day starts at 01:00.
export function dayStart(day: string, timeZone: string): Date | null {
  return zonedTime(day, 0, 0, timeZone) ?? zonedTime(day, 1, 0, timeZone);
}

const dayNumber = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

export function addDays(day: string, days: number): string {
  return new Date((dayNumber(day) + days) * 86_400_000).toISOString().slice(0, 10);
}

// 0 = Monday ... 6 = Sunday (the index into windowsByDay).
export function weekday(day: string): number {
  return (new Date(dayNumber(day) * 86_400_000).getUTCDay() + 6) % 7;
}

// The canonical name of a valid IANA zone, else the fallback (normally the instance default, config.timeZone).
export function safeTimeZone(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value || value.length > 64) return fallback;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return fallback;
  }
}
