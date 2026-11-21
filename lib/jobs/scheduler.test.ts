import { beforeEach, expect, it, vi } from "vitest";

// runJobs with the database and the reminder mail stubbed: what each claimed job ends as.

const state = vi.hoisted(() => ({
  jobs: [] as Record<string, unknown>[],
  bookings: [] as Record<string, unknown>[],
  finished: [] as [string, string, string | null][],
  mails: [] as string[],
  failMail: new Set<string>(),
}));

vi.mock("./plan", () => ({ loadReminderOffsets: async () => [1440, 60] }));
vi.mock("@/lib/mail/booking", () => ({
  sendReminderMail: async (bookingId: string) => {
    if (state.failMail.has(bookingId)) throw new Error("db down");
    state.mails.push(bookingId);
    return "sent";
  },
}));
vi.mock("@/lib/db/admin", () => ({
  createAdminSupabase: () => ({
    rpc: async (name: string, args: Record<string, string>) => {
      if (name === "claim_due_jobs") return { data: state.jobs, error: null };
      state.finished.push([args.p_job_id, args.p_state, args.p_error]);
      return { error: null };
    },
    from: () => ({ select: () => ({ in: async () => ({ data: state.bookings, error: null }) }) }),
  }),
}));

const { runJobs } = await import("./scheduler");

const start = "2030-01-07T09:00:00.000Z";
const job = (id: string, booking: string, attempts = 1, step = "reminder_1440m") => ({ id, booking_id: booking, step_key: step, planned_for: start, attempts });

beforeEach(() => {
  state.finished = [];
  state.mails = [];
  state.failMail = new Set();
  state.bookings = [
    { id: "b1", state: "booked", starts_at: start },
    { id: "b2", state: "cancelled", starts_at: start },
    { id: "b3", state: "booked", starts_at: start },
  ];
});

it("sends due reminders, cancels those that no longer apply, and retries or fails a broken one", async () => {
  state.jobs = [job("j1", "b1"), job("j2", "b2"), job("j3", "b3", 1), job("j4", "b3", 3), job("j5", "b1", 1, "briefing")];
  state.failMail.add("b3");
  const counts = await runJobs({ now: new Date("2030-01-06T09:01:00Z") });
  expect(state.mails).toEqual(["b1"]);
  expect(state.finished).toEqual([
    ["j1", "done", null],
    ["j2", "cancelled", "booking not booked"],
    ["j3", "planned", "db down"],
    ["j4", "failed", "db down"],
    ["j5", "failed", "unknown step"],
  ]);
  expect(counts).toEqual({ done: 1, cancelled: 1, retry: 1, failed: 2 });
});

it("does nothing without due jobs", async () => {
  state.jobs = [];
  expect(await runJobs()).toEqual({ done: 0, cancelled: 0, retry: 0, failed: 0 });
  expect(state.finished).toEqual([]);
});
