import { describe, expect, it } from "vitest";
import { linkPrefill, linkStatus, linkUrl, parseLinkForm } from "./links";
import type { Question } from "./questions";

const questions: Question[] = [
  { id: "size", label: "Team size", type: "choice", choices: ["1-10", "11-50"], required: true },
  { id: "tools", label: "Tools", type: "multi", choices: ["A", "B", "C"] },
  { id: "notes", label: "Notes", type: "text" },
];

describe("linkPrefill", () => {
  it("keeps cleaned strings, a real zone and valid answers only", () => {
    expect(
      linkPrefill(
        {
          name: "  Ada ​ Example ",
          email: "ada@example.com",
          company: 42,
          phone: "",
          timezone: "Europe/Berlin",
          answers: { size: "11-50", tools: ["C", "A", "X"], notes: "hi", unknown: "x" },
          metadata: { secret: "never" },
        },
        questions,
      ),
    ).toEqual({ name: "Ada Example", email: "ada@example.com", timeZone: "Europe/Berlin", answers: { size: "11-50", notes: "hi" } });
  });

  it("keeps a multi-line topic, as a widget's host page sends it", () => {
    expect(linkPrefill({ topic: "  First line\r\n\r\n\r\nSecond  " }, questions)).toEqual({ topic: "First line\n\nSecond" });
  });

  it("drops a bad zone, wrong choices and anything that is not an object", () => {
    expect(linkPrefill({ timezone: "Mars/Base", answers: { size: "huge" } }, questions)).toEqual({});
    expect(linkPrefill(["x"], questions)).toEqual({});
    expect(linkPrefill(null, questions)).toEqual({});
  });
});

describe("linkStatus", () => {
  const now = new Date("2026-11-04T09:00:00Z");
  const base = { single_use: false, used_at: null, expires_at: null, revoked_at: null };
  it("is revoked before used before expired", () => {
    expect(linkStatus(base, now)).toBe("active");
    expect(linkStatus({ ...base, used_at: "2026-11-01T00:00:00Z" }, now)).toBe("active");
    expect(linkStatus({ ...base, single_use: true, used_at: "2026-11-01T00:00:00Z" }, now)).toBe("used");
    expect(linkStatus({ ...base, expires_at: "2026-11-04T09:00:00Z" }, now)).toBe("expired");
    expect(linkStatus({ ...base, expires_at: "2026-11-04T09:00:01Z" }, now)).toBe("active");
    expect(linkStatus({ ...base, single_use: true, used_at: "2026-11-01T00:00:00Z", revoked_at: "2026-11-02T00:00:00Z" }, now)).toBe("revoked");
  });
});

describe("linkUrl", () => {
  it("joins the app URL and the token, with or without a trailing slash or base path", () => {
    expect(linkUrl("https://book.example.com", "abc")).toBe("https://book.example.com/l/abc");
    expect(linkUrl("https://example.com/booking/", "abc")).toBe("https://example.com/booking/l/abc");
  });
});

describe("parseLinkForm", () => {
  const ok = (r: ReturnType<typeof parseLinkForm>) => {
    if ("error" in r) throw new Error(r.error);
    return r;
  };

  it("parses prefill, partial answers, metadata, single use and expiry", () => {
    expect(
      ok(
        parseLinkForm(
          { name: " Ada ", email: "ada@example.com", company: "", single_use: "on", expires_days: " 7 " },
          { tools: ["B"] },
          [
            ["campaign", " spring "],
            ["", ""],
            ["ref.id", "42"],
          ],
          questions,
        ),
      ),
    ).toEqual({ prefill: { name: "Ada", email: "ada@example.com", answers: { tools: ["B"] } }, metadata: { campaign: "spring", "ref.id": "42" }, singleUse: true, expiresInDays: 7 });
    expect(ok(parseLinkForm({}, {}, [], questions))).toEqual({ prefill: {}, metadata: {}, singleUse: false, expiresInDays: null });
  });

  it("rejects bad email, invalid choices, bad metadata and bad expiry", () => {
    const cases: [Parameters<typeof parseLinkForm>[0], Record<string, unknown>, [unknown, unknown][], RegExp][] = [
      [{ email: "ada@" }, {}, [], /email/],
      [{}, { size: "huge" }, [], /Team size/],
      [{}, {}, [["bad key", "x"]], /keys/],
      [{}, {}, [["", "value without key"]], /keys/],
      [{}, {}, [["a", "1"], ["a", "2"]], /twice/],
      [{}, {}, [["a", "x".repeat(501)]], /at most 500/],
      [{}, {}, Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"] as [unknown, unknown]), /At most 20/],
      [{ expires_days: "0" }, {}, [], /Expiry/],
      [{ expires_days: "366" }, {}, [], /Expiry/],
      [{ expires_days: "1.5" }, {}, [], /Expiry/],
    ];
    for (const [fields, answers, meta, error] of cases) {
      const result = parseLinkForm(fields, answers, meta, questions);
      expect("error" in result && result.error, JSON.stringify(fields) + JSON.stringify(meta).slice(0, 80)).toMatch(error);
    }
  });
});
