// Pure rules for the account settings page. They mirror the database checks (profiles ranges, the availability grid and
// set_availability_day's overlap check), so members get a clear message before the database refuses.

export const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const; // ISO 1-7

export type TimeWindow = { start: string; end: string };

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

// "HH:MM-HH:MM, HH:MM-HH:MM" (any dash, commas or line breaks between) -> sorted windows on the 30-minute grid.
// Empty text means not bookable that day. Windows may touch but not overlap.
export function parseWindows(text: string): { windows: TimeWindow[] } | { error: string } {
  const parts = text.split(/[,\n]/).map((part) => part.trim()).filter(Boolean);
  const windows: TimeWindow[] = [];
  for (const part of parts) {
    const match = /^(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})$/.exec(part);
    if (!match) return { error: `"${part}" is not a time window like 09:00-12:00.` };
    const [start, end] = [`${match[1].padStart(2, "0")}:${match[2]}`, `${match[3].padStart(2, "0")}:${match[4]}`];
    for (const time of [start, end]) {
      if (Number(time.slice(0, 2)) > 23 || !["00", "30"].includes(time.slice(3))) {
        return { error: `${time} is not a valid time on the half hour (00:00 to 23:30).` };
      }
    }
    if (minutes(start) >= minutes(end)) return { error: `${start}-${end}: the start must be before the end.` };
    windows.push({ start, end });
  }
  windows.sort((a, b) => minutes(a.start) - minutes(b.start));
  for (let i = 1; i < windows.length; i++) {
    const [a, b] = [windows[i - 1], windows[i]];
    if (minutes(b.start) < minutes(a.end)) return { error: `${a.start}-${a.end} and ${b.start}-${b.end} overlap.` };
  }
  return { windows };
}

export const formatWindows = (windows: TimeWindow[]) => windows.map((w) => `${w.start}-${w.end}`).join(", ");

// Database rows (time as HH:MM:SS) grouped by ISO weekday, sorted.
export function windowsByDay(rows: { weekday: number; start_time: string; end_time: string }[]): TimeWindow[][] {
  const days: TimeWindow[][] = weekdays.map(() => []);
  for (const row of rows) days[row.weekday - 1]?.push({ start: row.start_time.slice(0, 5), end: row.end_time.slice(0, 5) });
  for (const day of days) day.sort((a, b) => minutes(a.start) - minutes(b.start));
  return days;
}

// Same ranges as the profiles check constraints.
export const ruleLimits = {
  buffer_minutes: { min: 0, max: 240, label: "Buffer between bookings" },
  min_notice_hours: { min: 0, max: 720, label: "Minimum notice" },
  max_bookings_per_day: { min: 1, max: 20, label: "Max bookings per day" },
} as const;

export type Rules = { timezone: string; buffer_minutes: number; min_notice_hours: number; max_bookings_per_day: number; meet_auto: boolean };

export function parseRules(input: Record<keyof Rules, string | null>, zones: readonly string[]): { rules: Rules } | { error: string } {
  const timezone = input.timezone ?? "";
  if (!zones.includes(timezone)) return { error: "Choose a time zone from the list." };
  const numbers = {} as Record<keyof typeof ruleLimits, number>;
  for (const [field, { min, max, label }] of Object.entries(ruleLimits) as [keyof typeof ruleLimits, (typeof ruleLimits)[keyof typeof ruleLimits]][]) {
    const raw = (input[field] ?? "").trim();
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || value < min || value > max) return { error: `${label} must be a whole number from ${min} to ${max}.` };
    numbers[field] = value;
  }
  return { rules: { timezone, ...numbers, meet_auto: input.meet_auto === "on" } };
}

// The member's public booking page. Built from APP_URL only, never from request headers.
export const bookingLink = (appUrl: string, slug: string | null) => (slug ? new URL(slug, `${appUrl}/`).href : null);
