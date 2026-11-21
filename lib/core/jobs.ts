// Pure rules for booking jobs: which reminders a booking gets, and whether a claimed reminder still applies.
// Reminder offsets are minutes before the start, from settings key reminder_offsets_minutes (jsonb array); the step key
// encodes the offset (reminder_1440m), so changing the setting needs no migration and removed offsets are not sent.

export const defaultReminderOffsets = [1440, 60];
const maxOffsets = 5;
const maxOffsetMinutes = 30 * 24 * 60;

// A claimed job that fails this many times is failed for good; before that the next run retries it.
export const jobAttempts = 3;
// A claimed job counts as in progress this long; a run that died gives it back afterwards.
export const claimMinutes = 5;

// Positive whole minutes up to 30 days, unique, at most 5, largest first. Anything else falls back to the defaults;
// an empty array switches reminders off.
export function parseReminderOffsets(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > maxOffsets) return defaultReminderOffsets;
  if (!value.every((m) => Number.isInteger(m) && m > 0 && m <= maxOffsetMinutes)) return defaultReminderOffsets;
  const offsets = [...new Set(value as number[])];
  return offsets.length === value.length ? offsets.sort((a, b) => b - a) : defaultReminderOffsets;
}

export const reminderStepKey = (minutes: number) => `reminder_${minutes}m`;

export function reminderOffset(stepKey: string): number | null {
  const match = /^reminder_([1-9]\d*)m$/.exec(stepKey);
  return match ? Number(match[1]) : null;
}

// One job per offset at start - offset, only those still ahead.
export function reminderJobs({ startsAt, now, offsets }: { startsAt: Date; now: Date; offsets: number[] }) {
  return offsets
    .map((m) => ({ stepKey: reminderStepKey(m), runAt: new Date(startsAt.getTime() - m * 60_000) }))
    .filter((job) => job.runAt > now)
    .sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
}

// A late reminder still goes out until the next smaller reminder is due; the smallest one until the start.
export function latestRun(offset: number, offsets: number[], startsAt: Date): Date {
  const smaller = offsets.filter((m) => m < offset);
  return new Date(startsAt.getTime() - (smaller.length ? Math.max(...smaller) : 0) * 60_000);
}

export type JobCheck = { run: true; sendUntil: Date } | { run: false; state: "cancelled" | "failed"; reason: string };

// Whether a claimed reminder still applies. Belt and braces on top of the cancel trigger and the re-plan: the booking must
// still be booked at the start the job was planned for.
export function checkJob({
  stepKey,
  plannedFor,
  booking,
  offsets,
  now,
}: {
  stepKey: string;
  plannedFor: Date;
  booking: { state: string; startsAt: Date } | null;
  offsets: number[];
  now: Date;
}): JobCheck {
  const offset = reminderOffset(stepKey);
  if (offset === null) return { run: false, state: "failed", reason: "unknown step" };
  if (!booking || booking.state !== "booked") return { run: false, state: "cancelled", reason: "booking not booked" };
  if (booking.startsAt.getTime() !== plannedFor.getTime()) return { run: false, state: "cancelled", reason: "booking rescheduled" };
  if (!offsets.includes(offset)) return { run: false, state: "cancelled", reason: "off" };
  const sendUntil = latestRun(offset, offsets, booking.startsAt);
  if (now >= sendUntil) return { run: false, state: "cancelled", reason: "too late" };
  return { run: true, sendUntil };
}
