import { describe, expect, it } from "vitest";
import { checkJob, defaultReminderOffsets, latestRun, parseReminderOffsets, reminderJobs, reminderOffset, reminderStepKey } from "./jobs";

const start = new Date("2026-12-10T10:00:00Z");
const offsets = [1440, 60];

describe("parseReminderOffsets", () => {
  it("keeps valid offsets, largest first", () => {
    expect(parseReminderOffsets([60, 1440, 15])).toEqual([1440, 60, 15]);
    expect(parseReminderOffsets([])).toEqual([]);
  });
  it("falls back to the defaults for anything else", () => {
    for (const bad of [null, "60", [0], [-5], [1.5], ["60"], [60, 60], [1, 2, 3, 4, 5, 6], [30 * 24 * 60 + 1]]) {
      expect(parseReminderOffsets(bad)).toEqual(defaultReminderOffsets);
    }
  });
});

describe("step keys", () => {
  it("round-trips the offset and rejects other keys", () => {
    expect(reminderStepKey(1440)).toBe("reminder_1440m");
    expect(reminderOffset("reminder_1440m")).toBe(1440);
    for (const key of ["reminder_0m", "reminder_24h", "briefing", "reminder_m"]) expect(reminderOffset(key)).toBeNull();
  });
});

describe("reminderJobs", () => {
  it("plans one job per offset before the start, skipping those already past", () => {
    expect(reminderJobs({ startsAt: start, now: new Date("2026-12-01T00:00:00Z"), offsets })).toEqual([
      { stepKey: "reminder_1440m", runAt: new Date("2026-12-09T10:00:00Z") },
      { stepKey: "reminder_60m", runAt: new Date("2026-12-10T09:00:00Z") },
    ]);
    expect(reminderJobs({ startsAt: start, now: new Date("2026-12-09T12:00:00Z"), offsets })).toEqual([
      { stepKey: "reminder_60m", runAt: new Date("2026-12-10T09:00:00Z") },
    ]);
    expect(reminderJobs({ startsAt: start, now: new Date("2026-12-10T09:00:00Z"), offsets })).toEqual([]);
  });
});

describe("latestRun", () => {
  it("is the next smaller reminder's run time, or the start for the smallest", () => {
    expect(latestRun(1440, offsets, start)).toEqual(new Date("2026-12-10T09:00:00Z"));
    expect(latestRun(60, offsets, start)).toEqual(start);
    expect(latestRun(1440, [2880, 1440, 120, 15], start)).toEqual(new Date("2026-12-10T08:00:00Z"));
  });
});

describe("checkJob", () => {
  const job = { stepKey: "reminder_1440m", plannedFor: start, offsets, now: new Date("2026-12-09T10:01:00Z") };
  const booked = { state: "booked", startsAt: start };

  it("runs a due reminder until the next one is due", () => {
    expect(checkJob({ ...job, booking: booked })).toEqual({ run: true, sendUntil: new Date("2026-12-10T09:00:00Z") });
  });
  it("cancels for a cancelled, missing or moved booking", () => {
    expect(checkJob({ ...job, booking: { ...booked, state: "cancelled" } })).toMatchObject({ run: false, state: "cancelled" });
    expect(checkJob({ ...job, booking: null })).toMatchObject({ run: false, state: "cancelled" });
    expect(checkJob({ ...job, booking: { ...booked, startsAt: new Date("2026-12-11T10:00:00Z") } })).toEqual({
      run: false,
      state: "cancelled",
      reason: "booking rescheduled",
    });
  });
  it("cancels when it is too late or the offset was removed from the settings", () => {
    expect(checkJob({ ...job, booking: booked, now: new Date("2026-12-10T09:00:00Z") })).toEqual({ run: false, state: "cancelled", reason: "too late" });
    expect(checkJob({ ...job, booking: booked, offsets: [60] })).toEqual({ run: false, state: "cancelled", reason: "off" });
  });
  it("fails an unknown step", () => {
    expect(checkJob({ ...job, stepKey: "briefing", booking: booked })).toEqual({ run: false, state: "failed", reason: "unknown step" });
  });
});
