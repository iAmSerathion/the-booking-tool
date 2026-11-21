import { afterAll, describe, expect, it } from "vitest";
import { actAs, type Client, createAuthUser, pool, rollback } from "./db";

// claim_booking_outbox (supabase/migrations/20261201002100_webhook_outbox.sql): which outbox rows a scheduler run sends.

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

type Values = { next?: string; created?: string; delivered?: string; givenUp?: string };
async function addRow(client: Client, booking: string, type: string, values: Values = {}): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.booking_outbox (type, booking_id, payload, next_attempt_at, created_at, delivered_at, given_up_at)
     values ($1, $2, '{}', $3, $4, $5, $6) returning id`,
    [type, booking, values.next ?? minutes(-1), values.created ?? minutes(-1), values.delivered ?? null, values.givenUp ?? null],
  );
  return rows[0].id;
}

const claimSql = "select type, next_attempt_at from public.claim_booking_outbox($1, $2, $3, $4, $5) order by created_at";
const claim = async (client: Client, now: string, booking: string | null, { limit = 50, configured = true } = {}) =>
  (await client.query<{ type: string; next_attempt_at: Date }>(claimSql, [now, limit, 2, booking, configured])).rows;
const rowsOf = async (client: Client, booking: string) =>
  (
    await client.query("select type, delivered_at is not null as delivered, given_up_at is not null as given_up, last_error from public.booking_outbox where booking_id = $1 order by created_at", [
      booking,
    ])
  ).rows;

describe("claim_booking_outbox", () => {
  it("hands out only a booking's oldest pending row, until it is delivered or given up", () =>
    rollback(async (client) => {
      const booking = await addBooking(client);
      const other = await addBooking(client, "other@example.com");
      const created = await addRow(client, booking, "booking.created", { created: minutes(-3) });
      await addRow(client, booking, "booking.rescheduled", { created: minutes(-2) });
      await addRow(client, booking, "booking.cancelled", { created: minutes(-1) });
      await addRow(client, other, "booking.created", { created: minutes(-0.5) });
      await actAs(client, "service_role");

      expect((await claim(client, new Date().toISOString(), booking)).map((r) => r.type)).toEqual(["booking.created"]);
      // Leased, and the newer rows still wait behind it, even at a later simulated time.
      expect(await claim(client, minutes(1), booking)).toEqual([]);

      await client.query("update public.booking_outbox set delivered_at = now() where id = $1", [created]);
      expect((await claim(client, minutes(1), booking)).map((r) => r.type)).toEqual(["booking.rescheduled"]);
      // The given-up rescheduled row no longer holds back the cancel.
      await client.query("update public.booking_outbox set given_up_at = now(), last_error = 'http 500' where booking_id = $1 and type = 'booking.rescheduled'", [booking]);
      expect((await claim(client, minutes(1), null)).map((r) => r.type)).toEqual(["booking.cancelled", "booking.created"]);
    }));

  it("waits for a newer row's older sibling even when only the newer one is due", () =>
    rollback(async (client) => {
      const booking = await addBooking(client);
      await addRow(client, booking, "booking.created", { created: minutes(-3), next: minutes(30) });
      await addRow(client, booking, "booking.cancelled", { created: minutes(-1) });
      await actAs(client, "service_role");
      expect(await claim(client, new Date().toISOString(), booking)).toEqual([]);
      expect((await claim(client, minutes(31), booking)).map((r) => r.type)).toEqual(["booking.created"]);
    }));

  it("leases from the later of the real and the simulated clock, and keeps the limit", () =>
    rollback(async (client) => {
      const booking = await addBooking(client);
      const other = await addBooking(client, "other@example.com");
      await addRow(client, booking, "booking.created");
      await addRow(client, other, "booking.host_changed", { created: minutes(-5), next: minutes(10) });
      await actAs(client, "service_role");

      const [real] = await claim(client, new Date().toISOString(), booking);
      expect(real.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 60_000);
      const simulated = await claim(client, minutes(60), null, { limit: 1 });
      expect(simulated.map((r) => r.type)).toEqual(["booking.host_changed"]);
      expect(simulated[0].next_attempt_at.getTime()).toBeGreaterThan(Date.parse(minutes(61)));
      // The same simulated run does not see its own lease due again; the first row's real-clock lease is.
      expect((await claim(client, minutes(60), null)).map((r) => r.type)).toEqual(["booking.created"]);
    }));

  it("gives up pending rows older than 72 hours by the real clock", () =>
    rollback(async (client) => {
      const booking = await addBooking(client);
      await addRow(client, booking, "booking.created", { created: minutes(-73 * 60) });
      await addRow(client, booking, "booking.cancelled", { created: minutes(-71 * 60) });
      await actAs(client, "service_role");
      expect((await claim(client, new Date().toISOString(), booking)).map((r) => r.type)).toEqual(["booking.cancelled"]);
      expect(await rowsOf(client, booking)).toEqual([
        { type: "booking.created", delivered: false, given_up: true, last_error: "expired" },
        { type: "booking.cancelled", delivered: false, given_up: false, last_error: null },
      ]);
    }));

  it("without a webhook gives due rows up and returns nothing", () =>
    rollback(async (client) => {
      const booking = await addBooking(client);
      await addRow(client, booking, "booking.created", { created: minutes(-3) });
      await addRow(client, booking, "booking.rescheduled", { created: minutes(-2), delivered: minutes(-1) });
      await addRow(client, booking, "booking.cancelled", { created: minutes(-1), next: minutes(5) });
      await actAs(client, "service_role");
      expect(await claim(client, new Date().toISOString(), booking, { configured: false })).toEqual([]);
      expect(await rowsOf(client, booking)).toEqual([
        { type: "booking.created", delivered: false, given_up: true, last_error: "not configured" },
        { type: "booking.rescheduled", delivered: true, given_up: false, last_error: null },
        { type: "booking.cancelled", delivered: false, given_up: false, last_error: null },
      ]);
    }));

  it("deletes delivered and given-up rows after 30 days, but keeps a pending one until it is given up", () =>
    rollback(async (client) => {
      const booking = await addBooking(client);
      const old = minutes(-31 * 24 * 60);
      await addRow(client, booking, "booking.created", { created: old, delivered: old });
      await addRow(client, booking, "booking.rescheduled", { created: old, givenUp: old });
      await addRow(client, booking, "booking.cancelled", { created: old });
      await addRow(client, booking, "booking.host_changed", { created: minutes(-29 * 24 * 60), delivered: minutes(-1) });
      await actAs(client, "service_role");
      await claim(client, new Date().toISOString(), booking);
      expect(await rowsOf(client, booking)).toEqual([
        { type: "booking.cancelled", delivered: false, given_up: true, last_error: "expired" },
        { type: "booking.host_changed", delivered: true, given_up: false, last_error: null },
      ]);
      // The next run deletes the now given-up old row.
      await claim(client, new Date().toISOString(), booking);
      expect((await rowsOf(client, booking)).map((r) => r.type)).toEqual(["booking.host_changed"]);
    }));

  for (const role of ["anon", "authenticated"] as const) {
    it(`is not callable as ${role}`, () =>
      rollback(async (client) => {
        const booking = await addBooking(client);
        await actAs(client, role);
        await expect(claim(client, new Date().toISOString(), booking)).rejects.toMatchObject({ code: "42501" });
      }));
  }
});
