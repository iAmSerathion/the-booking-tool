import { afterAll, describe, expect, it } from "vitest";
import { actAs, type Client, createAuthUser, pool, rollback } from "./db";

afterAll(() => pool.end());

async function addProfile(client: Client, email: string): Promise<string> {
  const id = await createAuthUser(client, email);
  await client.query("insert into public.profiles (id, name, email, timezone) values ($1, $2, $3, 'UTC')", [id, email.split("@")[0], email]);
  return id;
}

async function sqlError(client: Client, sql: string, params: unknown[] = []): Promise<{ code: string; message: string }> {
  await client.query("savepoint expect_error");
  try {
    await client.query(sql, params);
  } catch (error) {
    await client.query("rollback to savepoint expect_error");
    const { code, message } = error as { code: string; message: string };
    return { code, message };
  }
  throw new Error(`expected an error from: ${sql}`);
}

async function scalar<T>(client: Client, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await client.query(sql, params);
  return Object.values(rows[0])[0] as T;
}

const day = new Date(Date.now() + 2 * 86_400_000);
day.setUTCHours(0, 0, 0, 0);
const at = (hours: number, minutes = 0) => new Date(day.getTime() + (hours * 60 + minutes) * 60_000).toISOString();
const iso = (value: unknown) => new Date(value as string).toISOString();

// Inserts a booked booking directly as postgres (the hold flow is covered in bookings.test.ts).
async function addBooking(client: Client, host: string, starts = at(10), ends = at(10, 30)): Promise<string> {
  return scalar(
    client,
    `insert into public.bookings (event_type_id, host_id, starts_at, ends_at, booked_via, invitee_name, invitee_email)
     values ((select value #>> '{}' from public.settings where key = 'default_event_type_id')::uuid, $1, $2, $3, 'page',
       'Ada Example', 'ada@example.com')
     returning id`,
    [host, starts, ends],
  );
}

type Job = { id: string; step_key: string; state: string; attempts: number; last_error: string | null; planned_for: string };
async function jobs(client: Client, bookingId: string): Promise<Job[]> {
  const { rows } = await client.query<Job>(
    "select id, step_key, state::text, attempts, last_error, planned_for from public.booking_jobs where booking_id = $1 order by created_at, run_at",
    [bookingId],
  );
  return rows;
}

const planSql = "select public.plan_booking_jobs($1, $2::jsonb, $3) as n";
// startsAt: the start the run_at values were computed from; by default the booking's current start.
const plan = async (client: Client, bookingId: string, steps: [string, string][], startsAt?: string) =>
  scalar<number>(client, planSql, [
    bookingId,
    JSON.stringify(steps.map(([step_key, run_at]) => ({ step_key, run_at }))),
    startsAt ?? (await scalar<Date | null>(client, "select starts_at from public.bookings where id = $1", [bookingId])),
  ]);
const claimSql = "select * from public.claim_due_jobs($1, $2, $3, $4)";
const claim = async (client: Client, now: string, bookingId: string | null, limit = 50, minutes = 5) =>
  (await client.query<Job>(claimSql, [now, limit, minutes, bookingId])).rows;

describe("plan_booking_jobs", () => {
  it("plans jobs for the current start and cancels open ones when replanned", () =>
    rollback(async (client) => {
      const host = await addProfile(client, "host@example.com");
      const booking = await addBooking(client, host);
      await actAs(client, "service_role");

      expect(await plan(client, booking, [["reminder_24h", at(-14)], ["reminder_1h", at(9)]])).toBe(2);
      const first = await jobs(client, booking);
      expect(first.map((j) => [j.step_key, j.state, iso(j.planned_for)])).toEqual([
        ["reminder_24h", "planned", at(10)],
        ["reminder_1h", "planned", at(10)],
      ]);

      // A done job stays done; only planned ones are replaced.
      await client.query("select public.finish_job($1, 'done', null)", [first[0].id]);
      expect(await plan(client, booking, [["reminder_1h", at(9)]])).toBe(1);
      const states = (await jobs(client, booking)).map((j) => [j.step_key, j.state, j.last_error]);
      expect(states).toEqual([
        ["reminder_24h", "done", null],
        ["reminder_1h", "cancelled", "replanned"],
        ["reminder_1h", "planned", null],
      ]);
    }));

  it("plans nothing for a cancelled booking and rejects an unknown one", () =>
    rollback(async (client) => {
      const host = await addProfile(client, "host@example.com");
      const booking = await addBooking(client, host);
      await client.query("update public.bookings set state = 'cancelled', cancelled_by = 'host' where id = $1", [booking]);
      await actAs(client, "service_role");
      expect(await plan(client, booking, [["reminder_1h", at(9)]])).toBe(0);
      expect(await jobs(client, booking)).toEqual([]);
      expect((await sqlError(client, planSql, ["00000000-0000-0000-0000-000000000000", "[]", at(10)])).code).toBe("P0002");
    }));

  it("plans nothing and keeps the open jobs when the booking moved after the jobs were computed", () =>
    rollback(async (client) => {
      const host = await addProfile(client, "host@example.com");
      const booking = await addBooking(client, host, at(12), at(12, 30));
      await actAs(client, "service_role");
      expect(await plan(client, booking, [["reminder_1h", at(11)]])).toBe(1);

      // A calendar sync computed its jobs for 10:00, but the booking has moved on to 12:00 since.
      expect(await plan(client, booking, [["reminder_1h", at(9)]], at(10))).toBe(0);
      expect((await jobs(client, booking)).map((j) => [j.state, iso(j.planned_for)])).toEqual([["planned", at(12)]]);
    }));
});

describe("bookings_cancel_jobs trigger", () => {
  it("cancels open jobs on reschedule and cancel, but not on a response-only calendar update", () =>
    rollback(async (client) => {
      const host = await addProfile(client, "host@example.com");
      const booking = await addBooking(client, host);
      await actAs(client, "service_role");
      await plan(client, booking, [["reminder_1h", at(9)]]);

      await client.query("select public.calendar_booking_update($1, $2::jsonb)", [booking, JSON.stringify({ responses: { "ada@example.com": "accepted" } })]);
      expect((await jobs(client, booking)).map((j) => j.state)).toEqual(["planned"]);

      const holdId = await scalar(client, "select public.hold_slot($1, $2, $3, 0, 10, $4, $5, $6)", [host, at(12), at(12, 30), at(0), at(24), booking]);
      await client.query("select public.reschedule_booking($1, $2, $3, $4)", [booking, holdId, at(12), at(12, 30)]);
      expect((await jobs(client, booking)).map((j) => [j.state, j.last_error])).toEqual([["cancelled", "booking rescheduled"]]);

      await plan(client, booking, [["reminder_1h", at(11)]]);
      expect(iso((await jobs(client, booking)).at(-1)?.planned_for)).toBe(at(12));
      await client.query("select public.cancel_booking($1)", [booking]);
      expect((await jobs(client, booking)).map((j) => j.last_error)).toEqual(["booking rescheduled", "booking cancelled"]);
    }));

  it("runs with definer rights when a host without table rights cancels", () =>
    rollback(async (client) => {
      const host = await addProfile(client, "host@example.com");
      const booking = await addBooking(client, host);
      await actAs(client, "service_role");
      await plan(client, booking, [["reminder_1h", at(9)]]);

      await client.query("reset role");
      await actAs(client, "authenticated", host);
      expect((await sqlError(client, "select 1 from public.booking_jobs")).code).toBe("42501");
      await client.query("select public.cancel_booking_as_host($1)", [booking]);

      await client.query("reset role");
      expect((await jobs(client, booking)).map((j) => [j.state, j.last_error])).toEqual([["cancelled", "booking cancelled"]]);
    }));
});

describe("claim_due_jobs and finish_job", () => {
  it("claims due planned jobs once per claim window, scoped by booking", () =>
    rollback(async (client) => {
      const host = await addProfile(client, "host@example.com");
      const a = await addBooking(client, host);
      const b = await addBooking(client, host, at(14), at(14, 30));
      await actAs(client, "service_role");
      await plan(client, a, [["reminder_24h", at(-14)], ["reminder_1h", at(9)]]);
      await plan(client, b, [["reminder_1h", at(13)]]);

      // Simulated clock at 09:30: only a's jobs are due; scoped to b nothing is.
      expect(await claim(client, at(9, 30), b)).toEqual([]);
      const claimed = await claim(client, at(9, 30), a, 1);
      expect(claimed.map((j) => [j.step_key, j.attempts])).toEqual([["reminder_24h", 1]]);
      expect((await claim(client, at(9, 30), null)).map((j) => j.step_key)).toEqual(["reminder_1h"]);
      // Within the claim window nothing is taken again; with a zero-minute window it is.
      expect(await claim(client, at(9, 30), a)).toEqual([]);
      await client.query("update public.booking_jobs set claimed_at = now() - interval '1 minute' where id = $1", [claimed[0].id]);
      expect((await claim(client, at(9, 30), a, 50, 0)).map((j) => [j.id, j.attempts])).toEqual([[claimed[0].id, 2]]);

      // Retry: planned again and claimable; then done. A cancelled job stays cancelled.
      await client.query("select public.finish_job($1, 'planned', 'smtp timeout')", [claimed[0].id]);
      expect((await claim(client, at(9, 30), a)).map((j) => j.attempts)).toEqual([3]);
      await client.query("select public.finish_job($1, 'done', null)", [claimed[0].id]);
      const done = await client.query("select state::text, done_at, claimed_at, last_error from public.booking_jobs where id = $1", [claimed[0].id]);
      expect(done.rows[0]).toMatchObject({ state: "done", claimed_at: null, last_error: null });
      expect(done.rows[0].done_at).not.toBeNull();

      const [bJob] = await jobs(client, b);
      await client.query("select public.finish_job($1, 'cancelled', 'no longer applies')", [bJob.id]);
      await client.query("select public.finish_job($1, 'done', null)", [bJob.id]);
      expect((await jobs(client, b))[0]).toMatchObject({ state: "cancelled", last_error: "no longer applies" });
    }));

  it("lets two concurrent scheduler runs take different jobs", async () => {
    const setup = await pool.connect();
    const r1 = await pool.connect();
    const r2 = await pool.connect();
    let host = "";
    try {
      host = await addProfile(setup, "scheduler-host@example.com");
      const booking = await addBooking(setup, host);
      await plan(setup, booking, [["reminder_24h", at(-14)], ["reminder_1h", at(9)]]);

      await r1.query("begin");
      await actAs(r1, "service_role");
      const first = await claim(r1, at(9, 30), booking, 1);
      await r2.query("begin");
      await actAs(r2, "service_role");
      const second = await claim(r2, at(9, 30), booking, 1);
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(second[0].id).not.toBe(first[0].id);
      await r1.query("commit");
      await r2.query("commit");
    } finally {
      await r1.query("rollback").catch(() => {});
      await r2.query("rollback").catch(() => {});
      if (host) {
        await setup.query("delete from public.bookings where host_id = $1", [host]);
        await setup.query("delete from public.profiles where id = $1", [host]);
        await setup.query("delete from auth.users where id = $1", [host]);
      }
      for (const c of [setup, r1, r2]) c.release();
    }
  });
});

describe("outbound_mails", () => {
  it("defaults to pending and rejects a second mail with the same send_key", () =>
    rollback(async (client) => {
      const host = await addProfile(client, "host@example.com");
      const booking = await addBooking(client, host);
      await actAs(client, "service_role");
      const insert = `insert into public.outbound_mails (send_key, booking_id, kind, "to", subject, body_text, send_until)
        values ($1, $2, 'confirmation', array['ada@example.com'], 'Booked', 'See you', $3) returning state::text, attempts`;
      const { rows } = await client.query(insert, [`confirmation:${booking}`, booking, at(10)]);
      expect(rows[0]).toEqual({ state: "pending", attempts: 0 });
      expect((await sqlError(client, insert, [`confirmation:${booking}`, booking, at(10)])).code).toBe("23505");
      // A mail without a booking (e.g. an invite) fits too.
      await client.query("insert into public.outbound_mails (send_key, kind) values ('invite:1', 'invite')");
    }));
});

describe("grants and RLS", () => {
  it("gives anon and members no access to tables or functions; service_role has both", () =>
    rollback(async (client) => {
      const member = await addProfile(client, "member@example.com");
      const booking = await addBooking(client, member);
      const statements: [string, unknown[]][] = [
        ["select 1 from public.booking_jobs", []],
        ["select 1 from public.outbound_mails", []],
        ["insert into public.outbound_mails (send_key, kind) values ('x', 'invite')", []],
        ["insert into public.booking_jobs (booking_id, step_key, run_at, planned_for) values ($1, 'x', now(), now())", [booking]],
        [planSql, [booking, "[]", at(10)]],
        [claimSql, [at(10), 10, 5, null]],
        ["select public.finish_job(gen_random_uuid(), 'done', null)", []],
      ];
      for (const role of ["anon", "authenticated"] as const) {
        await actAs(client, role, role === "authenticated" ? member : undefined);
        for (const [sql, params] of statements) {
          expect((await sqlError(client, sql, params)).code, `${role}: ${sql}`).toBe("42501");
        }
        await client.query("reset role");
      }

      await actAs(client, "service_role");
      for (const [sql, params] of statements) await client.query(sql, params);
    }));
});
