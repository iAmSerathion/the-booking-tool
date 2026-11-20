import type { Locale } from "@/lib/config";
import { type MessageKey, t } from "@/lib/i18n";
import { zonedDay } from "./dates";
import { cleanMultiline, cleanText } from "./questions";

// The public booking page: who gets a booking, the invitee's details, the bot check and the customer-facing slot texts.
// Pure; used in the browser and on the server.

// Round robin: among the hosts free at the chosen time, the one whose last page or widget booking is oldest; hosts
// without one come first. Ties go by name, then id, so the order is always the same. The full order is the fallback
// list when a host's hold fails.
export type RoundRobinCandidate = { id: string; name: string; lastBookingAt: string | null };

export function roundRobinOrder(candidates: readonly RoundRobinCandidate[]): string[] {
  const at = (c: RoundRobinCandidate) => (c.lastBookingAt ? Date.parse(c.lastBookingAt) : -Infinity);
  return [...candidates]
    .sort((a, b) => at(a) - at(b) || a.name.localeCompare(b.name, "en") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => c.id);
}

export const roundRobinPick = (candidates: readonly RoundRobinCandidate[]): string | null => roundRobinOrder(candidates)[0] ?? null;

// Invitee details --------------------------------------------------------------------------------------------------

export type BookingInput = { name: string; email: string; company: string; phone: string; topic: string; privacy: boolean };
export type BookingField = "name" | "email" | "privacy";

// The database has no length checks on these columns, so the caps live here.
export const bookingInputLimits = { name: 200, email: 254, company: 200, phone: 50, topic: 2000 } as const;

export const emailPattern = /^[^@\s,;()<>]+@[^@\s,;()<>]+\.[^@\s,;()<>]+$/;

export function cleanBookingInput(raw: Partial<Record<keyof BookingInput, unknown>>): BookingInput {
  return {
    name: cleanText(raw.name, bookingInputLimits.name),
    email: cleanText(raw.email, bookingInputLimits.email),
    company: cleanText(raw.company, bookingInputLimits.company),
    phone: cleanText(raw.phone, bookingInputLimits.phone),
    topic: cleanMultiline(raw.topic, bookingInputLimits.topic),
    privacy: raw.privacy === true || raw.privacy === "on",
  };
}

// Name and email are required; company, phone and topic are optional. The privacy box is required only when the
// instance has a privacy notice to link to (PRIVACY_URL).
export function validateBooking(input: BookingInput, { privacyRequired }: { privacyRequired: boolean }): Partial<Record<BookingField, MessageKey>> {
  const errors: Partial<Record<BookingField, MessageKey>> = {};
  if (!input.name) errors.name = "booking.error.name";
  if (!input.email) errors.email = "booking.error.email";
  else if (!emailPattern.test(input.email)) errors.email = "booking.error.emailInvalid";
  if (privacyRequired && !input.privacy) errors.privacy = "booking.error.privacy";
  return errors;
}

// Bot protection without a captcha: a hidden field people leave empty and a minimum time from page load to submit.
// Both times come from the same browser clock; a start in the future is a forged value.
export const minFillMilliseconds = 3000;

export function looksLikeBot(p: { honeypot: string; startedAt: number; now: number }): boolean {
  const elapsed = p.now - p.startedAt;
  return p.honeypot.trim() !== "" || !Number.isFinite(p.startedAt) || elapsed < minFillMilliseconds;
}

// Slot lists for the invitee's zone ----------------------------------------------------------------------------------

// Free starts (ISO) grouped by the day in the invitee's zone, earliest first.
export function slotsByCustomerDay(starts: readonly string[], timeZone: string): Map<string, string[]> {
  const days = new Map<string, string[]>();
  for (const start of [...starts].sort()) {
    const day = zonedDay(new Date(start), timeZone);
    days.set(day, [...(days.get(day) ?? []), start]);
  }
  return days;
}

// The months the calendar must show, from the first to the last free day, as [year, month].
export function calendarMonths(days: readonly string[], today: string): [number, number][] {
  const sorted = [...days].sort();
  const first = sorted[0] ?? today;
  const last = sorted.at(-1) ?? first;
  const months: [number, number][] = [];
  let [y, m] = first.split("-").map(Number);
  const [ly, lm] = last.split("-").map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    months.push([y, m]);
    [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
  }
  return months;
}

// Customer-facing texts, always in the invitee's zone and the instance locale -----------------------------------------

const format = (locale: Locale, timeZone: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone, ...options });

// "10:30" (de) or "10:30 AM" (en).
export const formatTime = (at: Date, timeZone: string, locale: Locale) => format(locale, timeZone, { timeStyle: "short" }).format(at);

// A calendar day such as "Mittwoch, 4. November" or "Wednesday, November 4". Formatted at noon UTC, so no zone shifts it.
export const dayTitle = (day: string, locale: Locale) =>
  format(locale, "UTC", { weekday: "long", day: "numeric", month: "long" }).format(new Date(`${day}T12:00:00Z`));

// "Mi., 4. Nov., 10:30 bis 11:15" or "Wed, Nov 4, 10:30 AM to 11:15 AM".
export function slotChip(start: Date, end: Date, timeZone: string, locale: Locale): string {
  const day = format(locale, timeZone, { weekday: "short", day: "numeric", month: "short" }).format(start);
  return t(locale, "booking.slotRange", { day, start: formatTime(start, timeZone, locale), end: formatTime(end, timeZone, locale) });
}

// "Mittwoch, 4. November 2026, 10:30 bis 11:15" (confirmation).
export function slotLong(start: Date, end: Date, timeZone: string, locale: Locale): string {
  const day = format(locale, timeZone, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(start);
  return t(locale, "booking.slotRange", { day, start: formatTime(start, timeZone, locale), end: formatTime(end, timeZone, locale) });
}

// "You already have a booking on Wednesday, November 4, 10:30 AM." (duplicate check before a second booking).
export function alreadyBookedText(startsAt: Date, timeZone: string, locale: Locale): string {
  const when = format(locale, timeZone, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }).format(startsAt);
  return t(locale, "booking.error.already", { when });
}

// "Europe/Berlin (MEZ)" in German, "Europe/Berlin (GMT+1)" in English; the short name follows DST.
export function timeZoneLabel(timeZone: string, at: Date, locale: Locale): string {
  const short = format(locale, timeZone, { timeZoneName: "short" })
    .formatToParts(at)
    .find((part) => part.type === "timeZoneName")?.value;
  return short ? `${timeZone} (${short})` : timeZone;
}
