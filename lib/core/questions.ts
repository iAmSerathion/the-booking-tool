import type { MessageKey } from "@/lib/i18n";

// Text cleaning for everything an invitee types, and the answers to an event type's questions (event_types.questions,
// shape checked by event_type_questions_valid in the database). Pure; used in the browser and again on the server.

export type Question = { id: string; label: string; type: "choice" | "multi" | "text"; choices?: string[]; required?: boolean };

// What bookings.answers stores, in question order. choice and text answers are strings; multi answers are string arrays
// in the order of the question's choices, so webhook consumers never have to split a joined string.
export type Answer = { id: string; question: string; answer: string | string[] };

export const answerMaxLength = 500;

// Invisible characters go (soft hyphens, zero-width and bidi controls); other control characters become spaces.
const invisible = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
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

// The admin's question list for an event type, from the questions builder (a JSON array). Mirrors
// event_type_questions_valid, so the admin gets a precise message instead of the database's generic one. Labels and
// choices are cleaned, empty choices dropped, duplicates removed. A question without an id (a new one) gets one made
// from its label; existing ids are kept, because link prefills, widget prefills and stored answers refer to them.
export const maxQuestions = 20;
export const maxChoices = 30;
const labelMax = 200;
const idPattern = /^[a-z][a-z0-9_-]{0,39}$/;
const types = ["choice", "multi", "text"] as const;

export function parseQuestions(raw: unknown): { questions: Question[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "The questions could not be read. Please try again." };
  if (raw.length > maxQuestions) return { error: `An event type has at most ${maxQuestions} questions.` };
  const items = raw.map((item) => (item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {}));
  const taken = new Set<string>();
  for (const [i, item] of items.entries()) {
    if (item.id === undefined || item.id === "") continue;
    if (typeof item.id !== "string" || !idPattern.test(item.id) || taken.has(item.id)) return { error: `Question ${i + 1} could not be read. Please reload the page.` };
    taken.add(item.id);
  }
  const questions: Question[] = [];
  for (const [i, item] of items.entries()) {
    const at = `Question ${i + 1}`;
    const label = cleanText(item.label, labelMax + 1);
    if (!label) return { error: `${at} needs a label.` };
    if (label.length > labelMax) return { error: `${at}: a label has at most ${labelMax} characters.` };
    const type = types.find((t) => t === item.type);
    if (!type) return { error: `${at}: choose a type.` };
    const id = typeof item.id === "string" && item.id ? item.id : questionId(label, taken);
    taken.add(id);
    const question: Question = { id, label, type, required: item.required === true };
    if (type !== "text") {
      const list = Array.isArray(item.choices) ? item.choices.map((c) => cleanText(c, labelMax + 1)).filter(Boolean) : [];
      const choices = [...new Set(list)];
      if (choices.length === 0) return { error: `${at} needs at least one choice.` };
      if (choices.length > maxChoices) return { error: `${at} has more than ${maxChoices} choices.` };
      if (choices.some((c) => c.length > labelMax)) return { error: `${at}: a choice has at most ${labelMax} characters.` };
      question.choices = choices;
    }
    questions.push(question);
  }
  return { questions };
}

// "How many people?" -> "how-many-people"; "2 people" -> "q-2-people"; a taken id gets -2, -3, ...
export function questionId(label: string, taken: ReadonlySet<string>): string {
  const slug = label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
  const base = /^[a-z]/.test(slug) ? slug : slug ? `q-${slug}` : "q";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}
