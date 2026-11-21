import { cleanBookingInput, emailPattern } from "./booking";
import { safeTimeZone } from "./dates";
import { cleanText, type Question, validateAnswers } from "./questions";

// Booking links (booking_links): what a link prefills, the admin form that creates one, and its state. Pure.

// What the booking form starts with on "/l/<token>". Keys as stored in booking_links.prefill (rebook_link writes name,
// email, company, phone, timezone; the admin form also answers). A widget's host page sends the same keys plus topic.
export type Prefill = { name?: string; email?: string; company?: string; phone?: string; topic?: string; timeZone?: string; answers?: Record<string, string | string[]> };

// Stored prefill -> the form's initial values. Members write prefill directly (RLS insert), so everything is cleaned
// again here: strings only, length caps, a real time zone, and only valid answers to the event type's questions.
export function linkPrefill(raw: unknown, questions: readonly Question[]): Prefill {
  const given = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const input = cleanBookingInput(given);
  const prefill: Prefill = {};
  for (const key of ["name", "email", "company", "phone", "topic"] as const) if (input[key]) prefill[key] = input[key];
  const zone = safeTimeZone(given.timezone, "");
  if (zone) prefill.timeZone = zone;
  const answers = validateAnswers(questions, given.answers).answers;
  if (answers.length) prefill.answers = Object.fromEntries(answers.map((a) => [a.id, a.answer]));
  return prefill;
}

export type LinkStatus = "active" | "used" | "expired" | "revoked";

export function linkStatus(link: { single_use: boolean; used_at: string | null; expires_at: string | null; revoked_at: string | null }, now: Date): LinkStatus {
  if (link.revoked_at) return "revoked";
  if (link.single_use && link.used_at) return "used";
  if (link.expires_at && new Date(link.expires_at) <= now) return "expired";
  return "active";
}

// Built from APP_URL only, never from request headers.
export const linkUrl = (appUrl: string, token: string) => new URL(`l/${token}`, `${appUrl.replace(/\/+$/, "")}/`).href;

export const metadataLimits = { pairs: 20, key: 40, value: 500 };
const metadataKey = /^[A-Za-z0-9_.-]{1,40}$/;

export type LinkForm = {
  prefill: { name?: string; email?: string; company?: string; answers?: Record<string, string | string[]> };
  metadata: Record<string, string>;
  singleUse: boolean;
  // Whole days from now, or null for no expiry.
  expiresInDays: number | null;
};

// The admin "new link" form. fields: name, email, company, single_use, expires_days; answers: question id -> answer;
// meta: [key, value] rows (empty rows ignored). Errors are English, like the rest of the admin.
export function parseLinkForm(
  fields: { name?: unknown; email?: unknown; company?: unknown; single_use?: unknown; expires_days?: unknown },
  answers: Record<string, unknown>,
  meta: readonly [unknown, unknown][],
  questions: readonly Question[],
): LinkForm | { error: string } {
  const input = cleanBookingInput(fields);
  if (input.email && !emailPattern.test(input.email)) return { error: "The prefilled email does not look complete." };

  // Prefill may be partial, so a missing required answer is fine; a choice the question does not offer is not.
  const checked = validateAnswers(questions, answers);
  const invalid = Object.entries(checked.errors).find(([, key]) => key === "booking.error.answerInvalid");
  if (invalid) return { error: `The prefilled answer to "${questions.find((q) => q.id === invalid[0])?.label}" is not one of its choices.` };

  const metadata: Record<string, string> = {};
  for (const [rawKey, rawValue] of meta) {
    const key = cleanText(rawKey, 100);
    const value = cleanText(rawValue, 10_000);
    if (!key && !value) continue;
    if (!metadataKey.test(key)) return { error: `Metadata keys use letters, digits, "_", "." and "-" (1 to ${metadataLimits.key} characters).` };
    if (Object.hasOwn(metadata, key)) return { error: `The metadata key "${key}" appears twice.` };
    if (Array.from(value).length > metadataLimits.value) return { error: `Metadata values have at most ${metadataLimits.value} characters.` };
    metadata[key] = value;
  }
  if (Object.keys(metadata).length > metadataLimits.pairs) return { error: `At most ${metadataLimits.pairs} metadata entries.` };

  const days = typeof fields.expires_days === "string" ? fields.expires_days.trim() : "";
  let expiresInDays: number | null = null;
  if (days) {
    expiresInDays = Number(days);
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) return { error: "Expiry is a whole number of days from 1 to 365, or empty." };
  }

  const prefill: LinkForm["prefill"] = {};
  for (const key of ["name", "email", "company"] as const) if (input[key]) prefill[key] = input[key];
  if (checked.answers.length) prefill.answers = Object.fromEntries(checked.answers.map((a) => [a.id, a.answer]));
  return { prefill, metadata, singleUse: fields.single_use === "on" || fields.single_use === true, expiresInDays };
}
