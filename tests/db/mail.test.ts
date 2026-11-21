import { afterAll, describe, expect, it } from "vitest";
import { actAs, type Client, createAuthUser, pool, rollback } from "./db";

// claim_mail_retries (supabase/migrations/20261201001700_mail_retries.sql): which pending mails a scheduler run retries.

afterAll(() => pool.end());

async function addBooking(client: Client, email = "host@example.com"): Promise<string> {
  const host = await createAuthUser(client, email);
  await client.query("insert into public.profiles (id, name, email, timezone) values ($1, 'host', $2, 'UTC')", [host, email]);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.bookings (event_type_id, host_id, starts_at, ends_at, booked_via, invitee_name, invitee_email)
     values ((select value #>> '{}' from public.settings where key = 'default_event_type_id')::uuid, $1,
       date_trunc('minute', now()) + interval '2 days', date_trunc('minute', now()) + interval '2 days 30 minutes', 'page', 'Ada Example', 'ada@example.com')
     returning id`,
    [host],
  );
  return rows[0].id;
}

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

// The kind is the send_key's first segment, as sendMail stores it.
async function addMail(client: Client, booking: string, key: string, values: { state?: string; next?: string; until?: string | null } = {}) {
  await client.query(
    `insert into public.outbound_mails (send_key, booking_id, kind, "to", subject, body_text, state, next_attempt_at, send_until)
     values ($1, $2, split_part($1, ':', 1), array['ada@example.com'], 'Booked', 'See you', $3, $4, $5)`,
    [key, booking, values.state ?? "pending", values.next ?? minutes(-1), values.until === undefined ? minutes(60) : values.until],
  );
}
const startOf = async (client: Client, booking: string) =>
  ((await client.query<{ s: Date }>("select starts_at as s from public.bookings where id = $1", [booking])).rows[0].s as Date).toISOString();

const claimSql = "select send_key, next_attempt_at from public.claim_mail_retries($1, $2, $3, $4) order by send_key";
const claim = async (client: Client, now: string, booking: string | null, limit = 50) =>
  (await client.query<{ send_key: string; next_attempt_at: Date }>(claimSql, [now, limit, 2, booking])).rows;
const states = async (client: Client, booking: string) =>
  (await client.query("select send_key, state::text, last_error from public.outbound_mails where booking_id = $1 order by send_key", [booking])).rows;

describe("claim_mail_retries", () => {
  it("claims only due pending mails of the booking and leases them against a second run", () =>
    rollback(async (client) => {
      const booking = await addBooking(client);
      const other = await addBooking(client, "other@example.com");
      await addMail(client, booking, "a:due");
      await addMail(client, booking, "b:later", { next: minutes(1) });
      await addMail(client, booking, "c:sent", { state: "sent" });
      await addMail(client, booking, "d:failed", { state: "failed" });
      await addMail(client, booking, "e:no-until", { until: null });
      await addMail(client, other, "f:other");
      await actAs(client, "service_role");

      const claimed = await claim(client, new Date().toISOString(), booking);
      expect(claimed.map((m) => m.send_key)).toEqual(["a:due", "e:no-until"]);
      // Leased for p_lease_minutes against the real clock.
      for (const m of claimed) expect(m.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 60_000);
      expect(await claim(client, new Date().toISOString(), booking)).toEqual([]);

      // A simulated clock reaches the later attempt but not the leases (2 minutes); the limit holds.
      expect((await claim(client, minutes(1.5), booking)).map((m) => m.send_key)).toEqual(["b:later"]);
      expect((await claim(client, minutes(1.5), null, 1)).map((m) => m.send_key)).toEqual(["f:other"]);
    }));

  it("fails pending mails past send_until by the real clock, whatever the simulated clock says", () =>
    rollback(async (client) => {
      const booking = await addBooking(client);
      await addMail(client, booking, "a:expired", { until: minutes(-1), next: minutes(-30) });
      await addMail(client, booking, "b:open", { until: minutes(30), next: minutes(-1) });
      await addMail(client, booking, "c:sent-expired", { state: "sent", until: minutes(-1) });
      await actAs(client, "service_role");

      // p_now far past b's send_until: b is still due, because send_until is judged by now().
      expect((await claim(client, minutes(120), booking)).map((m) => m.send_key)).toEqual(["b:open"]);
      expect(await states(client, booking)).toEqual([
        { send_key: "a:expired", state: "failed", last_error: "expired" },
        { send_key: "b:open", state: "pending", last_error: null },
        { send_key: "c:sent-expired", state: "sent", last_error: null },
      ]);
    }));

  it("fails pending mails of a cancelled booking, but still sends its cancel notices", () =>
    rollback(async (client) => {
      const booking = await addBooking(client);
      const start = await startOf(client, booking);
      await addMail(client, booking, `confirmation:${booking}`);
      await addMail(client, booking, `reminder_1440m:${booking}:${start}`);
      await addMail(client, booking, `cancelled:${booking}`);
      await addMail(client, booking, `cancelled_host:${booking}`);
      await client.query("select public.cancel_booking($1)", [booking]);
      await actAs(client, "service_role");

      expect((await claim(client, new Date().toISOString(), booking)).map((m) => m.send_key).sort()).toEqual([`cancelled:${booking}`, `cancelled_host:${booking}`]);
      expect((await states(client, booking)).filter((m) => m.state === "failed").sort((x, y) => (x.send_key < y.send_key ? -1 : 1))).toEqual([
        { send_key: `confirmation:${booking}`, state: "failed", last_error: "booking no longer applies" },
        { send_key: `reminder_1440m:${booking}:${start}`, state: "failed", last_error: "booking no longer applies" },
      ]);
    }));

  it("fails reminders and calendar move notices for a start the booking no longer has", () =>
    rollback(async (client) => {
      const booking = await addBooking(client);
      const old = await startOf(client, booking);
      await client.query("update public.bookings set starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day' where id = $1", [booking]);
      const start = await startOf(client, booking);
      await addMail(client, booking, `reminder_1440m:${booking}:${old}`);
      await addMail(client, booking, `reminder_60m:${booking}:${start}`);
      await addMail(client, booking, `calendar_moved:${booking}:${start}:${old}`);
      await addMail(client, booking, `calendar_moved:${booking}:${old}:${start}`);
      await addMail(client, booking, `rescheduled:${booking}:1`);
      await actAs(client, "service_role");

      expect((await claim(client, new Date().toISOString(), booking)).map((m) => m.send_key).sort()).toEqual([
        `calendar_moved:${booking}:${old}:${start}`,
        `reminder_60m:${booking}:${start}`,
        `rescheduled:${booking}:1`,
      ]);
      expect((await states(client, booking)).filter((m) => m.state === "failed").map((m) => [m.send_key, m.last_error]).sort()).toEqual([
        [`calendar_moved:${booking}:${start}:${old}`, "booking no longer applies"],
        [`reminder_1440m:${booking}:${old}`, "booking no longer applies"],
      ]);
    }));

  it("is for service_role only", () =>
    rollback(async (client) => {
      const booking = await addBooking(client);
      for (const role of ["anon", "authenticated"] as const) {
        await client.query("savepoint s");
        await actAs(client, role);
        await expect(claim(client, new Date().toISOString(), booking)).rejects.toMatchObject({ code: "42501" });
        await client.query("rollback to savepoint s");
      }
      await actAs(client, "service_role");
      expect(await claim(client, new Date().toISOString(), booking)).toEqual([]);
    }));
});
