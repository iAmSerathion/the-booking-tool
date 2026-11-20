import { afterAll, describe, expect, it } from "vitest";
import { actAs, type Client, createAuthUser, pool, rollback } from "./db";

afterAll(() => pool.end());

type ProfileOptions = { isAdmin?: boolean; bookable?: boolean; active?: boolean };

// Creates an auth user plus profile as postgres. Call before actAs().
async function addProfile(client: Client, email: string, options: ProfileOptions = {}): Promise<string> {
  const id = await createAuthUser(client, email);
  await client.query("insert into public.profiles (id, name, email, is_admin, bookable, active, timezone) values ($1, $2, $3, $4, $5, $6, 'UTC')", [
    id,
    email.split("@")[0],
    email,
    options.isAdmin ?? false,
    options.bookable ?? true,
    options.active ?? true,
  ]);
  return id;
}

async function removeProfile(client: Client, id: string) {
  await client.query("delete from public.slot_holds where host_id = $1", [id]);
  await client.query("delete from public.profiles where id = $1", [id]);
  await client.query("delete from auth.users where id = $1", [id]);
}

// Runs a statement that must fail, inside a savepoint so the test transaction stays usable.
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

// Times two days ahead (reschedule and cancel refuse past bookings), on a UTC day grid.
const day = new Date(Date.now() + 2 * 86_400_000);
day.setUTCHours(0, 0, 0, 0);
const at = (hours: number, minutes = 0) => new Date(day.getTime() + (hours * 60 + minutes) * 60_000).toISOString();
const dayFrom = at(0);
const dayTo = at(24);
const hash = (n: number) => n.toString(16).padStart(64, "0");

const holdSql = "select public.hold_slot($1, $2, $3, $4, $5, $6, $7, $8) as id";
type HoldOptions = { buffer?: number; max?: number; except?: string | null };
async function hold(client: Client, host: string, starts: string, ends: string, o: HoldOptions = {}): Promise<string | null> {
  return scalar(client, holdSql, [host, starts, ends, o.buffer ?? 0, o.max ?? 10, dayFrom, dayTo, o.except ?? null]);
}

type BookingInput = { host: string; eventType: string; starts: string; ends: string } & Record<string, unknown>;
function bookingJson({ host, eventType, starts, ends, ...rest }: BookingInput) {
  return JSON.stringify({
    event_type_id: eventType,
    host_id: host,
    starts_at: starts,
    ends_at: ends,
    booked_via: "page",
    invitee_name: " Ada Example ",
    invitee_email: "Ada@Example.com",
    google_event_id: "evt-1",
    token_hash: hash(Math.floor(Math.random() * 1e12)),
    ...rest,
  });
}

const createSql = "select public.create_booking($1, $2::jsonb) as id";
// Hold, then create, as the server does. Expects the current role to be service_role.
async function book(client: Client, input: BookingInput): Promise<string> {
  const holdId = await hold(client, input.host, input.starts, input.ends);
  expect(holdId).not.toBeNull();
  return scalar(client, createSql, [holdId, bookingJson(input)]);
}

async function defaultEventType(client: Client): Promise<string> {
  return scalar(client, "select value #>> '{}' from public.settings where key = 'default_event_type_id'");
}

// Admin, host, other member and the seeded event type, created as postgres.
async function team(client: Client) {
  const admin = await addProfile(client, "admin@example.com", { isAdmin: true });
  const host = await addProfile(client, "host@example.com");
  const member = await addProfile(client, "member@example.com");
  const eventType = await defaultEventType(client);
  return { admin, host, member, eventType };
}

async function outbox(client: Client, bookingId: string) {
  const { rows } = await client.query<{ type: string; payload: Record<string, unknown> }>(
    "select type, payload from public.booking_outbox where booking_id = $1 order by created_at",
    [bookingId],
  );
  return rows;
}

describe("hold_slot", () => {
  it("blocks a second overlapping hold on the per-host lock until the first commits", async () => {
    const setup = await pool.connect();
    const a = await pool.connect();
    const b = await pool.connect();
    let host = "";
    try {
      host = await addProfile(setup, "parallel-host@example.com");
      await a.query("begin");
      await actAs(a, "service_role");
      expect(await hold(a, host, at(10), at(10, 30))).not.toBeNull();

      await b.query("begin");
      await actAs(b, "service_role");
      const pidB = await scalar<number>(b, "select pg_backend_pid()");
      const second = hold(b, host, at(10, 15), at(10, 45));
      let waiting = false;
      for (let i = 0; i < 50 && !waiting; i++) {
        const { rows } = await setup.query("select wait_event_type, wait_event from pg_stat_activity where pid = $1", [pidB]);
        waiting = rows[0]?.wait_event_type === "Lock" && rows[0]?.wait_event === "advisory";
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);

      await a.query("commit");
      expect(await second).toBeNull();
      await b.query("rollback");
    } finally {
      await a.query("rollback").catch(() => {});
      await b.query("rollback").catch(() => {});
      if (host) await removeProfile(setup, host);
      for (const c of [setup, a, b]) c.release();
    }
  });

  it("lets exactly one of two parallel holds for the same time succeed", async () => {
    const setup = await pool.connect();
    let host = "";
    try {
      host = await addProfile(setup, "race-host@example.com");
      const attempt = async () => {
        const c = await pool.connect();
        try {
          await c.query("begin");
          await actAs(c, "service_role");
          const id = await hold(c, host, at(11), at(11, 30));
          await c.query("commit");
          return id;
        } finally {
          await c.query("rollback").catch(() => {});
          c.release();
        }
      };
      const results = await Promise.all([attempt(), attempt()]);
      expect(results.filter((id) => id !== null)).toHaveLength(1);
    } finally {
      if (host) await removeProfile(setup, host);
      setup.release();
    }
  });

  it("respects bookings with buffer, the except argument, the daily maximum and expired holds", () =>
    rollback(async (client) => {
      const { host, eventType } = await team(client);
      await actAs(client, "service_role");
      const booked = await book(client, { host, eventType, starts: at(10), ends: at(10, 30) });

      // 10:30-11:00 touches the booking: free without buffer, taken with 15 minutes.
      expect(await hold(client, host, at(10, 30), at(11), { buffer: 15 })).toBeNull();
      expect(await hold(client, host, at(10, 15), at(10, 45))).toBeNull();
      const adjacent = await hold(client, host, at(10, 30), at(11));
      expect(adjacent).not.toBeNull();
      await client.query("select public.release_hold($1)", [adjacent]);

      // A reschedule may overlap its own booking, and the booking does not count for the day.
      expect(await hold(client, host, at(10, 15), at(10, 45), { except: booked, max: 1 })).not.toBeNull();
      expect(await hold(client, host, at(14), at(14, 30), { max: 1 })).toBeNull();
      await client.query("select public.release_hold($1)", [await scalar(client, "select id from public.slot_holds where host_id = $1", [host])]);
      // Under a higher maximum the day still has room.
      expect(await hold(client, host, at(15), at(15, 30), { max: 2 })).not.toBeNull();

      await client.query("reset role");
      await client.query("update public.slot_holds set expires_at = now() - interval '1 second' where host_id = $1", [host]);
      await actAs(client, "service_role");
      expect(await hold(client, host, at(10, 15), at(10, 45), { except: booked })).not.toBeNull();
      expect(await scalar(client, "select count(*)::int from public.slot_holds where host_id = $1", [host])).toBe(1);
    }));
});

describe("hold_slot concurrency", () => {
  // Runs the holds on separate connections at the same time, each committing on its own, and returns their results.
  async function parallel(host: string, holds: { starts: string; ends: string; o?: HoldOptions }[]) {
    return Promise.all(
      holds.map(async ({ starts, ends, o }) => {
        const c = await pool.connect();
        try {
          await c.query("begin");
          await actAs(c, "service_role");
          const id = await hold(c, host, starts, ends, o);
          await c.query("commit");
          return id;
        } finally {
          await c.query("rollback").catch(() => {});
          c.release();
        }
      }),
    );
  }

  async function withHost<T>(email: string, fn: (host: string) => Promise<T>): Promise<T> {
    const setup = await pool.connect();
    let host = "";
    try {
      host = await addProfile(setup, email);
      return await fn(host);
    } finally {
      if (host) await removeProfile(setup, host);
      setup.release();
    }
  }

  it("counts live holds toward the daily maximum when two invitees race for different times", () =>
    withHost("max-race@example.com", async (host) => {
      const results = await parallel(host, [
        { starts: at(10), ends: at(10, 30), o: { max: 1 } },
        { starts: at(14), ends: at(14, 30), o: { max: 1 } },
      ]);
      expect(results.filter((id) => id !== null)).toHaveLength(1);
      // Releasing the hold frees the day again; another day is unaffected.
      await withClient(async (c) => {
        await c.query("select public.release_hold($1)", [results.find((id) => id !== null)]);
        expect(await hold(c, host, at(16), at(16, 30), { max: 1 })).not.toBeNull();
      });
    }));

  it("keeps the buffer between concurrent holds, and allows adjacent holds without a buffer", async () => {
    await withHost("buffer-race@example.com", async (host) => {
      const buffered = await parallel(host, [
        { starts: at(10), ends: at(10, 30), o: { buffer: 15 } },
        { starts: at(10, 30), ends: at(11), o: { buffer: 15 } },
      ]);
      expect(buffered.filter((id) => id !== null)).toHaveLength(1);
    });
    await withHost("nobuffer-race@example.com", async (host) => {
      const plain = await parallel(host, [
        { starts: at(10), ends: at(10, 30) },
        { starts: at(10, 30), ends: at(11) },
      ]);
      expect(plain.filter((id) => id !== null)).toHaveLength(2);
    });
  });
});

async function withClient(fn: (client: Client) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await actAs(c, "service_role");
    await fn(c);
    await c.query("commit");
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
  }
}

describe("create_booking", () => {
  it("writes the booking and one outbox row and consumes the hold", () =>
    rollback(async (client) => {
      const { host, eventType } = await team(client);
      await actAs(client, "service_role");
      const holdId = await hold(client, host, at(10), at(10, 30));
      const answers = [{ id: "goal", question: "Goal?", answer: "Growth" }];
      const token = hash(1);
      const id = await scalar<string>(client, createSql, [
        holdId,
        bookingJson({ host, eventType, starts: at(10), ends: at(10, 30), answers, token_hash: token, invitee_company: "  ", topic: " Hi " }),
      ]);

      const { rows } = await client.query("select * from public.bookings where id = $1", [id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: "booked",
        booked_via: "page",
        invitee_name: "Ada Example",
        invitee_email: "ada@example.com",
        invitee_company: null,
        topic: "Hi",
        answers,
        token_hash: token,
        reschedule_count: 0,
      });

      const events = await outbox(client, id);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("booking.created");
      expect(events[0].payload).toMatchObject({ id, host_id: host, invitee_email: "ada@example.com" });
      for (const hidden of ["token_hash", "guest_responses", "google_change_until"]) expect(events[0].payload).not.toHaveProperty(hidden);

      expect(await scalar(client, "select count(*)::int from public.slot_holds where id = $1", [holdId])).toBe(0);
      expect((await sqlError(client, createSql, [holdId, bookingJson({ host, eventType, starts: at(10), ends: at(10, 30) })])).code).toBe(
        "P0002",
      );
    }));

  it("rejects a hold for a different time", () =>
    rollback(async (client) => {
      const { host, eventType } = await team(client);
      await actAs(client, "service_role");
      const holdId = await hold(client, host, at(10), at(10, 30));
      expect((await sqlError(client, createSql, [holdId, bookingJson({ host, eventType, starts: at(12), ends: at(12, 30) })])).code).toBe(
        "P0002",
      );
    }));

  it("refuses a host that was deactivated after the hold was taken", () =>
    rollback(async (client) => {
      const { host, eventType } = await team(client);
      await actAs(client, "service_role");
      const holdId = await hold(client, host, at(10), at(10, 30));
      await client.query("reset role");
      await client.query("update public.profiles set active = false where id = $1", [host]);
      await actAs(client, "service_role");
      expect((await sqlError(client, createSql, [holdId, bookingJson({ host, eventType, starts: at(10), ends: at(10, 30) })])).code).toBe(
        "P0002",
      );
    }));

  it("refuses a second upcoming booking of the same event type when asked to check, case-insensitively", () =>
    rollback(async (client) => {
      const { host, admin, eventType } = await team(client);
      const otherType = await scalar<string>(
        client,
        "insert into public.event_types (slug, title, duration_minutes) values ('intro', 'Intro', 30) returning id",
      );
      await actAs(client, "service_role");
      await book(client, { host, eventType, starts: at(10), ends: at(10, 30), invitee_email: "dup@example.com" });

      const holdId = await hold(client, admin, at(12), at(12, 30));
      const again = bookingJson({ host: admin, eventType, starts: at(12), ends: at(12, 30), invitee_email: "DUP@Example.com", check_upcoming: true });
      expect((await sqlError(client, createSql, [holdId, again])).code).toBe("P0003");
      // The failed call kept the hold, so the server can release it.
      expect(await scalar(client, "select count(*)::int from public.slot_holds where id = $1", [holdId])).toBe(1);

      // Another event type, or no check, is allowed.
      await scalar(client, createSql, [
        holdId,
        bookingJson({ host: admin, eventType: otherType, starts: at(12), ends: at(12, 30), invitee_email: "dup@example.com", check_upcoming: true }),
      ]);
      await book(client, { host: admin, eventType, starts: at(14), ends: at(14, 30), invitee_email: "dup@example.com" });
    }));

  it("enforces single use, expiry, host and event type of a booking link", () =>
    rollback(async (client) => {
      const { host, admin, eventType } = await team(client);
      const link = async (n: number, extra = "") =>
        scalar<string>(
          client,
          `insert into public.booking_links (token_hash, host_id, event_type_id, single_use, created_at, expires_at)
           values ($1, $2, $3, true, now() - interval '2 hours', ${extra || "null"}) returning id`,
          [hash(n), host, eventType],
        );
      const single = await link(1);
      const expired = await link(2, "now() - interval '1 hour'");
      const reusable = await scalar<string>(
        client,
        "insert into public.booking_links (token_hash, host_id, event_type_id) values ($1, $2, $3) returning id",
        [hash(3), host, eventType],
      );
      await actAs(client, "service_role");

      const viaLink = (starts: string, ends: string, linkId: string, h = host) =>
        bookingJson({ host: h, eventType, starts, ends, booked_via: "link", link_id: linkId });
      const first = await book(client, { host, eventType, starts: at(9), ends: at(9, 30), booked_via: "link", link_id: single });
      expect(await scalar(client, "select link_id from public.bookings where id = $1", [first])).toBe(single);
      expect(await scalar(client, "select used_at is not null from public.booking_links where id = $1", [single])).toBe(true);

      for (const [linkId, h, hour] of [
        [single, host, 11],
        [expired, host, 12],
        [reusable, admin, 13],
      ] as const) {
        const holdId = await hold(client, h, at(hour), at(hour, 30));
        expect((await sqlError(client, createSql, [holdId, viaLink(at(hour), at(hour, 30), linkId, h)])).code, linkId).toBe("P0004");
      }

      await book(client, { host, eventType, starts: at(14), ends: at(14, 30), booked_via: "link", link_id: reusable });
      await book(client, { host, eventType, starts: at(15), ends: at(15, 30), booked_via: "link", link_id: reusable });

      // A revoked link is closed even though it is reusable and not expired.
      await client.query("reset role");
      await client.query("update public.booking_links set revoked_at = now() where id = $1", [reusable]);
      await actAs(client, "service_role");
      const revokedHold = await hold(client, host, at(15, 30), at(16));
      expect((await sqlError(client, createSql, [revokedHold, viaLink(at(15, 30), at(16), reusable)])).code).toBe("P0004");
      await client.query("reset role");
      await client.query("update public.booking_links set revoked_at = null where id = $1", [reusable]);
      await actAs(client, "service_role");

      await client.query("reset role");
      await client.query("update public.profiles set bookable = false where id = $1", [host]);
      await actAs(client, "service_role");
      const holdId = await hold(client, host, at(16), at(16, 30));
      // The host check under the host lock comes before the link check.
      expect((await sqlError(client, createSql, [holdId, viaLink(at(16), at(16, 30), reusable)])).code).toBe("P0002");
    }));
});

describe("booking_event_payload", () => {
  it("carries the link id and metadata on every outbox row of a link booking, null without a link", () =>
    rollback(async (client) => {
      const { host, eventType } = await team(client);
      const linkId = await scalar<string>(
        client,
        "insert into public.booking_links (token_hash, host_id, event_type_id, metadata) values ($1, $2, $3, $4) returning id",
        [hash(1), host, eventType, JSON.stringify({ campaign: "spring", ref: "42" })],
      );
      await actAs(client, "service_role");
      const viaLink = await book(client, { host, eventType, starts: at(9), ends: at(9, 30), booked_via: "link", link_id: linkId });
      const viaPage = await book(client, { host, eventType, starts: at(11), ends: at(11, 30) });
      await client.query("select public.cancel_booking($1, 'invitee', null)", [viaLink]);

      const link = { id: linkId, metadata: { campaign: "spring", ref: "42" } };
      expect((await outbox(client, viaLink)).map((e) => [e.type, e.payload.link])).toEqual([
        ["booking.created", link],
        ["booking.cancelled", link],
      ]);
      const [created] = await outbox(client, viaPage);
      expect(created.payload).toHaveProperty("link", null);
    }));
});

describe("reschedule_booking", () => {
  const rescheduleSql = "select public.reschedule_booking($1, $2, $3, $4, $5) as n";

  it("moves the booking, counts it and writes a rescheduled outbox row", () =>
    rollback(async (client) => {
      const { host, eventType } = await team(client);
      await actAs(client, "service_role");
      const id = await book(client, { host, eventType, starts: at(10), ends: at(10, 30), invitee_timezone: "UTC" });

      const holdId = await hold(client, host, at(10, 15), at(10, 45), { except: id });
      expect(await scalar(client, rescheduleSql, [id, holdId, at(10, 15), at(10, 45), "Europe/Berlin"])).toBe(1);
      const { rows } = await client.query("select starts_at, ends_at, invitee_timezone from public.bookings where id = $1", [id]);
      expect(rows[0]).toEqual({ starts_at: new Date(at(10, 15)), ends_at: new Date(at(10, 45)), invitee_timezone: "Europe/Berlin" });
      expect(await scalar(client, "select count(*)::int from public.slot_holds where id = $1", [holdId])).toBe(0);

      const events = await outbox(client, id);
      expect(events.map((e) => e.type)).toEqual(["booking.created", "booking.rescheduled"]);
      const previous = events[1].payload.previous as { starts_at: string; ends_at: string };
      expect(new Date(previous.starts_at).toISOString()).toBe(at(10));
      expect(new Date(previous.ends_at).toISOString()).toBe(at(10, 30));
      expect(events[1].payload.changed_by).toBe("invitee");

      const mismatched = await hold(client, host, at(13), at(13, 30), { except: id });
      expect((await sqlError(client, rescheduleSql, [id, mismatched, at(14), at(14, 30), null])).code).toBe("P0002");
      expect((await sqlError(client, rescheduleSql, [id, holdId, at(10, 15), at(10, 45), null])).code).toBe("P0002");
    }));

  // deactivate_profile takes the host lock and then row-locks the bookings; reschedule must use the same order.
  it("waits for the host lock without holding the booking row, so it cannot deadlock with deactivate_profile", async () => {
    const setup = await pool.connect();
    const lock = await pool.connect();
    const mover = await pool.connect();
    let host = "";
    try {
      host = await addProfile(setup, "lock-order-host@example.com");
      const eventType = await defaultEventType(setup);
      const id = await book(setup, { host, eventType, starts: at(10), ends: at(10, 30) });
      const holdId = await hold(setup, host, at(15), at(15, 30), { except: id });

      await lock.query("begin");
      await lock.query("select pg_advisory_xact_lock(hashtext($1))", [`booking:${host}`]);
      const pid = await scalar<number>(mover, "select pg_backend_pid()");
      const moving = mover.query(rescheduleSql, [id, holdId, at(15), at(15, 30), null]);
      let waiting = false;
      for (let i = 0; i < 50 && !waiting; i++) {
        const { rows } = await setup.query("select wait_event from pg_stat_activity where pid = $1", [pid]);
        waiting = rows[0]?.wait_event === "advisory";
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);

      // The row is still free while reschedule waits; with the old order this failed with 55P03.
      await setup.query("begin");
      await setup.query("select id from public.bookings where id = $1 for update nowait", [id]);
      await setup.query("rollback");

      await lock.query("commit");
      expect((await moving).rows[0].n).toBe(1);
    } finally {
      await lock.query("rollback").catch(() => {});
      await setup.query("rollback").catch(() => {});
      if (host) {
        await setup.query("delete from public.bookings where host_id = $1", [host]);
        await removeProfile(setup, host);
      }
      for (const c of [setup, lock, mover]) c.release();
    }
  });
});

describe("cancel_booking and calendar sync", () => {
  it("cancels once, with the reason in the outbox", () =>
    rollback(async (client) => {
      const { host, eventType } = await team(client);
      await actAs(client, "service_role");
      const id = await book(client, { host, eventType, starts: at(10), ends: at(10, 30) });
      await client.query("select public.cancel_booking($1, 'invitee', $2)", [id, " Too busy "]);
      const { rows } = await client.query("select state, cancelled_by from public.bookings where id = $1", [id]);
      expect(rows[0]).toEqual({ state: "cancelled", cancelled_by: "invitee" });
      const events = await outbox(client, id);
      expect(events.map((e) => e.type)).toEqual(["booking.created", "booking.cancelled"]);
      expect(events[1].payload).toMatchObject({ reason: "Too busy", changed_by: "invitee", state: "cancelled" });
      expect((await sqlError(client, "select public.cancel_booking($1)", [id])).code).toBe("P0002");
    }));

  it("refuses to cancel a past booking", () =>
    rollback(async (client) => {
      const { host, eventType } = await team(client);
      const id = await scalar<string>(
        client,
        `insert into public.bookings (event_type_id, host_id, starts_at, ends_at, booked_via, invitee_name, invitee_email)
         values ($1, $2, now() - interval '1 hour', now() - interval '30 minutes', 'page', 'A', 'a@example.com') returning id`,
        [eventType, host],
      );
      await actAs(client, "service_role");
      expect((await sqlError(client, "select public.cancel_booking($1)", [id])).code).toBe("P0002");
    }));

  it("applies calendar deletes and moves, with outbox rows only for real changes", () =>
    rollback(async (client) => {
      const { host, eventType } = await team(client);
      await actAs(client, "service_role");
      const deleted = await book(client, { host, eventType, starts: at(9), ends: at(9, 30) });
      expect(await scalar(client, "select public.calendar_booking_deleted($1)", [deleted])).toBe(true);
      expect(await scalar(client, "select cancelled_by from public.bookings where id = $1", [deleted])).toBe("host");
      expect((await outbox(client, deleted)).map((e) => [e.type, e.payload.changed_by ?? null])).toEqual([
        ["booking.created", null],
        ["booking.cancelled", "calendar"],
      ]);
      expect(await scalar(client, "select public.calendar_booking_deleted($1)", [deleted])).toBe(false);

      const moved = await book(client, { host, eventType, starts: at(10), ends: at(10, 30) });
      const update = "select public.calendar_booking_update($1, $2::jsonb)";
      expect(await scalar(client, update, [moved, JSON.stringify({ responses: { "ada@example.com": "accepted" } })])).toBe(true);
      expect((await outbox(client, moved)).map((e) => e.type)).toEqual(["booking.created"]);
      expect(await scalar(client, update, [moved, JSON.stringify({ moved: { starts_at: at(16), ends_at: at(16, 30) } })])).toBe(true);
      const { rows } = await client.query("select starts_at, reschedule_count, guest_responses from public.bookings where id = $1", [moved]);
      expect(rows[0]).toEqual({ starts_at: new Date(at(16)), reschedule_count: 0, guest_responses: { "ada@example.com": "accepted" } });
      expect((await outbox(client, moved)).map((e) => [e.type, e.payload.changed_by ?? null])).toEqual([
        ["booking.created", null],
        ["booking.rescheduled", "calendar"],
      ]);
      expect(await scalar(client, update, [deleted, "{}"])).toBe(false);
    }));
});

describe("rebook_link", () => {
  it("creates a single-use prefilled link for a cancelled booking of a bookable host", () =>
    rollback(async (client) => {
      const { host, eventType } = await team(client);
      await actAs(client, "service_role");
      const id = await book(client, { host, eventType, starts: at(10), ends: at(10, 30), invitee_company: "Example Ltd" });
      expect(await scalar(client, "select public.rebook_link($1, $2)", [id, hash(7)])).toBe(false);
      await client.query("select public.cancel_booking($1)", [id]);
      expect(await scalar(client, "select public.rebook_link($1, $2)", [id, hash(7)])).toBe(true);
      const { rows } = await client.query("select host_id, event_type_id, single_use, prefill, metadata from public.booking_links where token_hash = $1", [
        hash(7),
      ]);
      expect(rows[0]).toEqual({
        host_id: host,
        event_type_id: eventType,
        single_use: true,
        prefill: { name: "Ada Example", email: "ada@example.com", company: "Example Ltd" },
        metadata: { rebook_of: id },
      });

      await client.query("reset role");
      await client.query("update public.profiles set active = false where id = $1", [host]);
      await actAs(client, "service_role");
      expect(await scalar(client, "select public.rebook_link($1, $2)", [id, hash(8)])).toBe(false);
    }));
});

describe("booking_attempt", () => {
  it("allows up to the limit per minute and purges old rows", () =>
    rollback(async (client) => {
      await client.query("insert into public.booking_attempts (ip_hash, at) values ('old', now() - interval '2 hours')");
      await actAs(client, "service_role");
      const attempt = () => scalar<boolean>(client, "select public.booking_attempt('ip-a', 2)");
      expect([await attempt(), await attempt(), await attempt()]).toEqual([true, true, false]);
      expect(await scalar(client, "select public.booking_attempt('ip-b', 2)")).toBe(true);
      expect(await scalar(client, "select count(*)::int from public.booking_attempts where ip_hash = 'old'")).toBe(0);
    }));
});

describe("grants and RLS", () => {
  it("closes the service functions and internal tables to anon and members", () =>
    rollback(async (client) => {
      const { host, eventType } = await team(client);
      const calls = [
        [holdSql, [host, at(10), at(10, 30), 0, 10, dayFrom, dayTo, null]],
        [createSql, [null, bookingJson({ host, eventType, starts: at(10), ends: at(10, 30) })]],
        ["select public.release_hold(gen_random_uuid())", []],
        ["select public.booking_attempt('x')", []],
        ["select public.reschedule_booking(gen_random_uuid(), gen_random_uuid(), now(), now())", []],
        ["select public.cancel_booking(gen_random_uuid())", []],
        ["select public.rebook_link(gen_random_uuid(), 'x')", []],
        ["select public.calendar_booking_update(gen_random_uuid(), '{}')", []],
        ["select public.calendar_booking_deleted(gen_random_uuid())", []],
        ["select * from public.slot_holds", []],
        ["select * from public.booking_outbox", []],
        ["select * from public.booking_tokens", []],
        ["select * from public.booking_attempts", []],
        ["update public.bookings set topic = 'x'", []],
        [
          "insert into public.bookings (event_type_id, host_id, starts_at, ends_at, booked_via, invitee_name, invitee_email) values ($1, $2, now(), now() + interval '1 hour', 'page', 'A', 'a@example.com')",
          [eventType, host],
        ],
      ] as const;
      for (const [role, user] of [
        ["anon", undefined],
        ["authenticated", host],
      ] as const) {
        await client.query("savepoint as_role");
        await actAs(client, role, user);
        for (const [sql, params] of calls) expect((await sqlError(client, sql, [...params])).code, `${role}: ${sql}`).toBe("42501");
        expect((await sqlError(client, "select public.cancel_booking_as_host(gen_random_uuid())")).code, role).toBe("42501");
        await client.query("rollback to savepoint as_role");
      }
    }));

  it("lets hosts read their own bookings and admins read all", () =>
    rollback(async (client) => {
      const { admin, host, member, eventType } = await team(client);
      const retired = await addProfile(client, "retired@example.com", { isAdmin: true, active: false });
      await actAs(client, "service_role");
      const id = await book(client, { host, eventType, starts: at(10), ends: at(10, 30) });
      await client.query("reset role");

      for (const [user, expected] of [
        [host, [id]],
        [admin, [id]],
        [member, []],
        [retired, []],
      ] as const) {
        await client.query("savepoint as_role");
        await actAs(client, "authenticated", user);
        const { rows } = await client.query("select id from public.bookings");
        expect(rows.map((r) => r.id)).toEqual(expected);
        await client.query("rollback to savepoint as_role");
      }
      await client.query("savepoint as_anon");
      await actAs(client, "anon");
      expect((await sqlError(client, "select id from public.bookings")).code).toBe("42501");
      await client.query("rollback to savepoint as_anon");
    }));
});

describe("cancel_booking_as_host", () => {
  it("lets the host or an admin cancel, nobody else", () =>
    rollback(async (client) => {
      const { admin, host, member, eventType } = await team(client);
      const retired = await addProfile(client, "retired@example.com");
      await actAs(client, "service_role");
      const first = await book(client, { host, eventType, starts: at(10), ends: at(10, 30) });
      const second = await book(client, { host, eventType, starts: at(12), ends: at(12, 30) });
      const retiredBooking = await book(client, { host: retired, eventType, starts: at(14), ends: at(14, 30) });
      await client.query("reset role");
      await client.query("update public.profiles set active = false where id = $1", [retired]);

      const cancel = "select public.cancel_booking_as_host($1, $2)";
      for (const [user, bookingId] of [
        [member, first],
        [retired, retiredBooking],
      ] as const) {
        await client.query("savepoint as_role");
        await actAs(client, "authenticated", user);
        expect((await sqlError(client, cancel, [bookingId, null])).code, user).toBe("42501");
        await client.query("rollback to savepoint as_role");
      }

      for (const [user, bookingId] of [
        [host, first],
        [admin, second],
      ] as const) {
        await client.query("savepoint as_role");
        await actAs(client, "authenticated", user);
        await client.query(cancel, [bookingId, "Host is ill"]);
        await client.query("reset role");
        await client.query("release savepoint as_role");
        expect(await scalar(client, "select cancelled_by from public.bookings where id = $1", [bookingId])).toBe("host");
        const events = await outbox(client, bookingId);
        expect(events[1]).toMatchObject({ type: "booking.cancelled", payload: { reason: "Host is ill", changed_by: "host" } });
      }
    }));
});
