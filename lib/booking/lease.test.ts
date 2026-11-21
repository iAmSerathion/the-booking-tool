import { beforeEach, describe, expect, it, vi } from "vitest";

// The lease with the database stubbed: dropLease must only clear the lease it took, never one another change took
// after ours expired.

const state = vi.hoisted(() => ({ updates: [] as { values: unknown; filters: [string, unknown][] }[], taken: true }));

vi.mock("@/lib/db/admin", () => ({
  createAdminSupabase: () => ({
    from: () => ({
      update: (values: unknown) => {
        const update = { values, filters: [] as [string, unknown][] };
        state.updates.push(update);
        const chain = {
          eq: (column: string, value: unknown) => (update.filters.push([column, value]), chain),
          or: (filter: string) => (update.filters.push(["or", filter]), chain),
          select: async () => ({ data: state.taken ? [{ id: "b1" }] : [], error: null }),
          then: (resolve: (r: unknown) => unknown) => resolve({ error: null }),
        };
        return chain;
      },
    }),
  }),
}));

const { dropLease, takeLease } = await import("./lease");

beforeEach(() => Object.assign(state, { updates: [], taken: true }));

describe("lease", () => {
  it("drops only the lease it took", async () => {
    const until = await takeLease("b1");
    expect(until).toBe((state.updates[0].values as { google_change_until: string }).google_change_until);
    await dropLease("b1", until!);
    expect(state.updates[1]).toEqual({
      values: { google_change_until: null },
      filters: [
        ["id", "b1"],
        ["google_change_until", until],
      ],
    });
  });

  it("gives null while another change holds the booking", async () => {
    state.taken = false;
    expect(await takeLease("b1")).toBeNull();
  });
});
