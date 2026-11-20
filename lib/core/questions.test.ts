import { describe, expect, it } from "vitest";
import { answerMaxLength, cleanMultiline, cleanText, type Question, validateAnswers } from "./questions";

describe("cleanText", () => {
  it("drops soft hyphens and invisible characters, control characters become spaces", () => {
    expect(cleanText("Manage\u00adment", 50)).toBe("Management");
    expect(cleanText("a\u200bb\u202ec\ufeffd", 50)).toBe("abcd");
    expect(cleanText(" 5\tto\n\n20\u0000 ", 50)).toBe("5 to 20");
  });

  it("cuts by characters without trailing whitespace", () => {
    expect(cleanText("ab cd", 3)).toBe("ab");
    expect(cleanText("€€€€", 2)).toBe("€€");
    expect(Array.from(cleanText("😀".repeat(10), 4))).toHaveLength(4);
  });

  it("anything but text becomes empty", () => {
    for (const value of [null, undefined, 5, {}, ["x"]]) expect(cleanText(value, 10)).toBe("");
  });
});

describe("cleanMultiline", () => {
  it("keeps line breaks, collapses whitespace per line and keeps at most one empty line", () => {
    expect(cleanMultiline("  First the sheet,\t then\u00a0 mails. \r\n\r\n\r\n\n  Then   follow up.  ", 100)).toBe("First the sheet, then mails.\n\nThen follow up.");
    expect(cleanMultiline("a\rb\u2028c\u2029d", 100)).toBe("a\nb\nc\nd");
    expect(cleanMultiline("a \n \n \n b", 100)).toBe("a\n\nb");
  });

  it("drops invisible characters and turns other control characters into spaces", () => {
    expect(cleanMultiline("Manage\u00adment\u200b\ufeff", 50)).toBe("Management");
    expect(cleanMultiline("a\u0000b\u0085c\u000bd\u000ce", 50)).toBe("a b c d e");
    expect(cleanMultiline("\u00ad \n\u200b\n\t", 50)).toBe("");
  });

  it("cuts by characters without trailing whitespace or line break", () => {
    expect(cleanMultiline("ab\ncd", 3)).toBe("ab");
    expect(Array.from(cleanMultiline("😀\n".repeat(10), 5))).toHaveLength(5);
  });

  it("anything but text becomes empty", () => {
    for (const value of [null, undefined, 5, {}, ["x"]]) expect(cleanMultiline(value, 10)).toBe("");
  });
});

describe("validateAnswers", () => {
  const questions: Question[] = [
    { id: "topic", label: "What would you like to talk about?", type: "choice", choices: ["Getting started", "Pricing"], required: true },
    { id: "tools", label: "Which tools do you use?", type: "multi", choices: ["Sheets", "Mail", "Chat"] },
    { id: "notes", label: "Anything else?", type: "text" },
  ];

  it("returns the answers in question order with the label the invitee saw", () => {
    const result = validateAnswers(questions, { notes: " Line one \r\nline two ", tools: ["Chat", "Sheets"], topic: "Pricing" });
    expect(result.errors).toEqual({});
    expect(result.answers).toEqual([
      { id: "topic", question: "What would you like to talk about?", answer: "Pricing" },
      { id: "tools", question: "Which tools do you use?", answer: ["Sheets", "Chat"] },
      { id: "notes", question: "Anything else?", answer: "Line one\nline two" },
    ]);
  });

  it("leaves out unanswered optional questions and unknown ids", () => {
    expect(validateAnswers(questions, { topic: "Pricing", tools: [], notes: "  ", extra: "x" })).toEqual({
      answers: [{ id: "topic", question: "What would you like to talk about?", answer: "Pricing" }],
      errors: {},
    });
  });

  it("a required question without an answer is an error", () => {
    for (const raw of [{}, { topic: "" }, { topic: " \u00ad " }, null, "x", []]) {
      expect(validateAnswers(questions, raw).errors).toEqual({ topic: "booking.error.answerRequired" });
    }
  });

  it("a choice must be one of the choices, also for multi", () => {
    expect(validateAnswers(questions, { topic: "Something else" }).errors).toEqual({ topic: "booking.error.answerInvalid" });
    expect(validateAnswers(questions, { topic: ["Pricing"] }).errors).toEqual({ topic: "booking.error.answerRequired" });
    expect(validateAnswers(questions, { topic: "Pricing", tools: ["Sheets", "Fax"] }).errors).toEqual({ tools: "booking.error.answerInvalid" });
    expect(validateAnswers(questions, { topic: "Pricing", tools: "Sheets" }).answers).toHaveLength(1);
  });

  it("a multi answer has no duplicates", () => {
    expect(validateAnswers(questions, { topic: "Pricing", tools: ["Mail", "Mail", " Mail "] }).answers[1].answer).toEqual(["Mail"]);
  });

  it("a text answer is capped", () => {
    expect(validateAnswers(questions, { topic: "Pricing", notes: "a".repeat(900) }).answers[1].answer).toHaveLength(answerMaxLength);
  });

  it("does not read inherited properties", () => {
    expect(validateAnswers([{ id: "constructor", label: "Q", type: "text", required: true }], {}).errors).toEqual({ constructor: "booking.error.answerRequired" });
  });
});
