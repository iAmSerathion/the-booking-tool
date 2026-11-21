import { beforeEach, describe, expect, it, vi } from "vitest";

// The event type admin actions with the member and the database stubbed: the admin guard comes before any database
// call, questions are checked before the RPC, and RPC errors map to admin-facing text. The RPCs themselves are tested
// against Postgres in tests/db/offers.test.ts.

const state = vi.hoisted(() => ({ isAdmin: true, error: null as { code: string; message: string } | null, calls: [] as unknown[][] }));

vi.mock("next/cache", () => ({ refresh: () => state.calls.push(["refresh"]) }));
vi.mock("@/lib/auth/member", () => ({
  signedIn: async () => ({
    isAdmin: state.isAdmin,
    supabase: { rpc: async (name: string, args: unknown) => (state.calls.push([name, args]), { data: null, error: state.error }) },
  }),
}));

const { saveEventType, setDefaultEventType, setEventTypeActive } = await import("./actions");

const typeId = "00000000-0000-4000-8000-000000000101";
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return data;
};
const valid = {
  event_type_id: "",
  title: "Intro",
  slug: "intro",
  description: "",
  duration_minutes: "45",
  questions: JSON.stringify([{ label: "Team size", type: "choice", choices: ["1-5", "6+"], required: true }]),
};
const empty = { error: null, saved: false };

beforeEach(() => {
  state.isAdmin = true;
  state.error = null;
  state.calls = [];
});

describe("event type actions", () => {
  it("saves through save_event_type with parsed questions", async () => {
    expect(await saveEventType(empty, form(valid))).toEqual({ error: null, saved: true });
    expect(state.calls).toEqual([
      [
        "save_event_type",
        {
          p_id: null,
          p_slug: "intro",
          p_title: "Intro",
          p_description: "",
          p_duration_minutes: 45,
          p_questions: [{ id: "team-size", label: "Team size", type: "choice", choices: ["1-5", "6+"], required: true }],
        },
      ],
      ["refresh"],
    ]);
  });

  it("refuses members before touching the database", async () => {
    state.isAdmin = false;
    const refused = { error: "Only admins can change event types.", saved: false };
    expect(await saveEventType(empty, form(valid))).toEqual(refused);
    expect(await setEventTypeActive(empty, form({ event_type_id: typeId, active: "false" }))).toEqual(refused);
    expect(await setDefaultEventType(empty, form({ event_type_id: typeId }))).toEqual(refused);
    expect(state.calls).toEqual([]);
  });

  it("checks ids and questions before the RPC", async () => {
    expect((await saveEventType(empty, form({ ...valid, questions: "{" }))).error).toBe("The questions could not be read. Please try again.");
    expect((await saveEventType(empty, form({ ...valid, questions: '[{"label":"x","type":"choice"}]' }))).error).toBe("Question 1 needs at least one choice.");
    expect((await saveEventType(empty, form({ ...valid, event_type_id: "nope" }))).error).toBe("This event type does not exist.");
    expect((await setEventTypeActive(empty, form({ event_type_id: "nope", active: "true" }))).error).toBe("This event type does not exist.");
    expect((await setDefaultEventType(empty, form({}))).error).toBe("This event type does not exist.");
    expect(state.calls).toEqual([]);
  });

  it("passes a non-integer duration as null, so the database explains the rule", async () => {
    await saveEventType(empty, form({ ...valid, duration_minutes: "abc" }));
    expect(state.calls[0][1]).toMatchObject({ p_duration_minutes: null });
  });

  it("switches and sets the default through their RPCs", async () => {
    await setEventTypeActive(empty, form({ event_type_id: typeId, active: "false" }));
    await setDefaultEventType(empty, form({ event_type_id: typeId }));
    expect(state.calls).toEqual([
      ["set_event_type_active", { p_id: typeId, p_active: false }],
      ["refresh"],
      ["set_default_event_type", { p_id: typeId }],
      ["refresh"],
    ]);
  });

  it("shows the database's message for 23514 and P0002, a generic one otherwise", async () => {
    state.error = { code: "23514", message: "The default event type cannot be switched off." };
    expect(await setEventTypeActive(empty, form({ event_type_id: typeId, active: "false" }))).toEqual({ error: state.error.message, saved: false });
    state.error = { code: "42501", message: "Only admins can change this." };
    expect((await setDefaultEventType(empty, form({ event_type_id: typeId }))).error).toBe("Only admins can change event types.");
    state.error = { code: "XX000", message: "boom" };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await saveEventType(empty, form(valid))).error).toBe("Saving failed. Please try again.");
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
