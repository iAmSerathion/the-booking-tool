import { beforeEach, describe, expect, it, vi } from "vitest";

// The widget admin actions with the member and the database stubbed: the admin guard comes before any database call,
// input is checked before the RPC, and RPC errors map to admin-facing text. The RPCs themselves (assert_is_admin,
// origin and host checks) are tested against Postgres in tests/db/offers.test.ts.

const state = vi.hoisted(() => ({ isAdmin: true, error: null as { code: string; message: string } | null, calls: [] as unknown[][] }));

vi.mock("next/cache", () => ({ refresh: () => state.calls.push(["refresh"]) }));
vi.mock("@/lib/auth/member", () => ({
  signedIn: async () => ({
    isAdmin: state.isAdmin,
    supabase: { rpc: async (name: string, args: unknown) => (state.calls.push([name, args]), { data: null, error: state.error }) },
  }),
}));

const { saveWidget, setWidgetActive } = await import("./actions");

const typeId = "00000000-0000-4000-8000-000000000101";
const hostId = "00000000-0000-4000-8000-000000000011";
const form = (fields: [string, string][]) => {
  const data = new FormData();
  for (const [k, v] of fields) data.append(k, v);
  return data;
};
const valid: [string, string][] = [
  ["widget_id", ""],
  ["name", "Pricing page"],
  ["mode", "person"],
  ["event_type_id", typeId],
  ["host_id", hostId],
  ["host_id", hostId],
  ["allowed_origins", "https://Example.com/\nhttp://127.0.0.1:3101"],
];
const empty = { error: null, saved: false };

beforeEach(() => {
  state.isAdmin = true;
  state.error = null;
  state.calls = [];
});

describe("widget actions", () => {
  it("saves through save_booking_widget with deduplicated hosts and normalised origins", async () => {
    expect(await saveWidget(empty, form(valid))).toEqual({ error: null, saved: true });
    expect(state.calls).toEqual([
      ["save_booking_widget", { p_id: null, p_name: "Pricing page", p_mode: "person", p_host_ids: [hostId], p_event_type_id: typeId, p_allowed_origins: ["http://127.0.0.1:3101", "https://example.com"] }],
      ["refresh"],
    ]);
  });

  it("refuses members before touching the database", async () => {
    state.isAdmin = false;
    expect(await saveWidget(empty, form(valid))).toEqual({ error: "Only admins can change widgets.", saved: false });
    expect(await setWidgetActive(empty, form([["widget_id", typeId], ["active", "false"]]))).toEqual({ error: "Only admins can change widgets.", saved: false });
    expect(state.calls).toEqual([]);
  });

  it("checks the input before the RPC", async () => {
    const without = (key: string, value: string): [string, string][] => [...valid.filter(([k]) => k !== key), [key, value]];
    expect((await saveWidget(empty, form(without("allowed_origins", "https://example.com/pricing")))).error).toMatch(/is not an origin/);
    expect((await saveWidget(empty, form(without("mode", "everyone")))).error).toBe("Choose who gets the bookings.");
    expect((await saveWidget(empty, form(without("event_type_id", "x")))).error).toBe("Choose an event type.");
    expect((await saveWidget(empty, form(without("widget_id", "nope")))).error).toBe("This widget does not exist.");
    expect(state.calls).toEqual([]);
  });

  it("shows the database's message for 23514 and P0002, a generic one otherwise", async () => {
    state.error = { code: "23514", message: "Please give the widget a name." };
    expect(await saveWidget(empty, form(valid))).toEqual({ error: "Please give the widget a name.", saved: false });
    state.error = { code: "42501", message: "permission denied" };
    expect((await saveWidget(empty, form(valid))).error).toBe("Only admins can change widgets.");
    state.error = { code: "XX000", message: "internal detail" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await saveWidget(empty, form(valid))).error).toBe("Saving failed. Please try again.");
  });

  it("switches a widget on and off", async () => {
    await setWidgetActive(empty, form([["widget_id", typeId], ["active", "false"]]));
    await setWidgetActive(empty, form([["widget_id", typeId], ["active", "true"]]));
    expect(state.calls.filter(([name]) => name !== "refresh")).toEqual([
      ["set_booking_widget_active", { p_id: typeId, p_active: false }],
      ["set_booking_widget_active", { p_id: typeId, p_active: true }],
    ]);
  });
});
