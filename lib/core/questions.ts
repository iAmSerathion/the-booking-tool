import type { MessageKey } from "@/lib/i18n";

// Text cleaning for everything an invitee types, and the answers to an event type's questions (event_types.questions,
// shape checked by event_type_questions_valid in the database). Pure; used in the browser and again on the server.

export type Question = { id: string; label: string; type: "choice" | "multi" | "text"; choices?: string[]; required?: boolean };

// What bookings.answers stores, in question order. choice and text answers are strings; multi answers are string arrays
// in the order of the question's choices, so webhook consumers never have to split a joined string.
export type Answer = { id: string; question: string; answer: string | string[] };

export const answerMaxLength = 500;

// Invisible characters go (soft hyphens, zero-width and bidi controls); other control characters become spaces.
const invisible = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const control = /[\u0000-\u001f\u007f-\u009f]/g;
const cut = (text: string, max: number) => Array.from(text).slice(0, max).join("").trim();

// One line: whitespace collapsed, at most max characters (code points). Anything but a string becomes "".
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return cut(value.replace(invisible, "").replace(control, " ").replace(/\s+/g, " ").trim(), max);
}

// Like cleanText, but line breaks stay: \r\n, \r, U+2028 and U+2029 become \n, whitespace is collapsed and trimmed per
// line, and more than one empty line in a row becomes one.
export function cleanMultiline(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value
    .replace(invisible, "")
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cut(text, max);
}

// raw: question id -> the invitee's answer (a string, or a list of strings for multi). Unknown ids are ignored.
// An unanswered optional question is left out; errors are per question id.
export function validateAnswers(
  questions: readonly Question[],
  raw: unknown,
): { answers: Answer[]; errors: Partial<Record<string, MessageKey>> } {
  const given = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const answers: Answer[] = [];
  const errors: Partial<Record<string, MessageKey>> = {};
  for (const question of questions) {
    const value = Object.hasOwn(given, question.id) ? given[question.id] : undefined;
    const choices = question.choices ?? [];
    let answer: string | string[] | null = null;
    if (question.type === "text") {
      answer = cleanMultiline(value, answerMaxLength) || null;
    } else if (question.type === "choice") {
      const picked = cleanText(value, answerMaxLength);
      if (picked && !choices.includes(picked)) {
        errors[question.id] = "booking.error.answerInvalid";
        continue;
      }
      answer = picked || null;
    } else {
      const list = Array.isArray(value) ? value.map((item) => cleanText(item, answerMaxLength)).filter(Boolean) : [];
      if (list.some((item) => !choices.includes(item))) {
        errors[question.id] = "booking.error.answerInvalid";
        continue;
      }
      answer = list.length ? choices.filter((choice) => list.includes(choice)) : null;
    }
    if (answer === null) {
      if (question.required) errors[question.id] = "booking.error.answerRequired";
      continue;
    }
    answers.push({ id: question.id, question: question.label, answer });
  }
  return { answers, errors };
}
