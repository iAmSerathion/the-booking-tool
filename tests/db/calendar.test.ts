import { afterAll, describe, expect, it } from "vitest";
import { actAs, type Client, createAuthUser, pool, rollback } from "./db";

afterAll(() => pool.end());

// Creates an auth user plus profile as postgres. Call before actAs().
async function addProfile(client: Client, email: string, active = true): Promise<string> {
  const id = await createAuthUser(client, email);
  await client.query("insert into public.profiles (id, name, email, active) values ($1, $2, $3, $4)", [
    id,
    email.split("@")[0],
    email,
    active,
  ]);
  return id;
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

const save = "select public.google_connection_save($1, $2, $3, $4, $5)";

async function connect(client: Client, userId: string, token = "token-1") {
  await client.query(save, [userId, "Owner@Example.com", token, ["calendar"], "primary@example.com"]);
}

describe("calendar connection functions", () => {
  it("are closed to anon and members, open to service_role", () =>
    rollback(async (client) => {
      const id = await addProfile(client, "fn@example.com");
      const calls = [
        [save, [id, "a@example.com", "t", [], null]],
        ["select public.google_refresh_token($1)", [id]],
        ["select public.google_connection_delete($1)", [id]],
        ["select public.calendar_sync_claim($1)", [id]],
        ["select public.calendar_sync_release($1, null, true)", [id]],
        ["select public.default_availability($1)", [id]],
      ] as const;
      for (const role of ["anon", "authenticated"] as const) {
        await client.query("savepoint as_role");
        await actAs(client, role, role === "authenticated" ? id : undefined);
        for (const [sql, params] of calls) {
          expect((await sqlError(client, sql, [...params])).code, `${role}: ${sql}`).toBe("42501");
        }
        await client.query("rollback to savepoint as_role");
      }
      await actAs(client, "service_role");
      await connect(client, id);
      expect(await scalar(client, "select public.google_refresh_token($1)", [id])).toBe("token-1");
    }));

  it("stores the token in Vault, replaces it on reconnect and removes it on delete", () =>
    rollback(async (client) => {
      const id = await addProfile(client, "vault@example.com");
      await connect(client, id);
      const secret = await scalar<string>(client, "select refresh_token_secret_id from public.calendar_connections where user_id = $1", [id]);
      expect(await scalar(client, "select account_email from public.calendar_connections where user_id = $1", [id])).toBe("owner@example.com");

      await client.query("update public.calendar_connections set status = 'needs_reconnect' where user_id = $1", [id]);
      await client.query(save, [id, "owner@example.com", "token-2", ["calendar"], null]);
      const { rows } = await client.query(
        "select refresh_token_secret_id, status, primary_calendar_id from public.calendar_connections where user_id = $1",
        [id],
      );
      expect(rows[0]).toEqual({ refresh_token_secret_id: secret, status: "ok", primary_calendar_id: "primary@example.com" });
      expect(await scalar(client, "select public.google_refresh_token($1)", [id])).toBe("token-2");

      await client.query("select public.google_connection_delete($1)", [id]);
      expect(await scalar(client, "select public.google_refresh_token($1)", [id])).toBeNull();
      expect(await scalar(client, "select count(*)::int from vault.secrets where id = $1", [secret])).toBe(0);
    }));

  it("keeps busy calendars and sync state on a reconnect with the same account", () =>
    rollback(async (client) => {
      const id = await addProfile(client, "same@example.com");
      await connect(client, id);
      await client.query(
        "update public.calendar_connections set busy_calendar_ids = '{primary@example.com,team@example.com}', sync_token = 's1', channel_id = 'c1' where user_id = $1",
        [id],
      );
      await client.query(save, [id, "OWNER@example.com", "token-2", ["calendar"], "primary@example.com"]);
      const { rows } = await client.query("select busy_calendar_ids, sync_token, channel_id from public.calendar_connections where user_id = $1", [id]);
      expect(rows[0]).toEqual({ busy_calendar_ids: ["primary@example.com", "team@example.com"], sync_token: "s1", channel_id: "c1" });
    }));

  it("resets busy calendars, sync state and push channel when another Google account is connected", () =>
    rollback(async (client) => {
      const id = await addProfile(client, "switch@example.com");
      await connect(client, id);
      await client.query(
        `update public.calendar_connections set busy_calendar_ids = '{primary@example.com,team@example.com}', sync_token = 's1', synced_at = now(),
           channel_id = 'c1', channel_resource_id = 'r1', channel_token_hash = 'h1', channel_expires_at = now(), channel_renewed_at = now() where user_id = $1`,
        [id],
      );
      await client.query(save, [id, "New@Example.com", "token-2", ["calendar"], "new@example.com"]);
      const { rows } = await client.query(
        `select account_email, primary_calendar_id, busy_calendar_ids, sync_token, synced_at, channel_id, channel_resource_id, channel_token_hash,
           channel_expires_at, channel_renewed_at from public.calendar_connections where user_id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({
        account_email: "new@example.com",
        primary_calendar_id: "new@example.com",
        busy_calendar_ids: ["new@example.com"],
        sync_token: null,
        synced_at: null,
        channel_id: null,
        channel_resource_id: null,
        channel_token_hash: null,
        channel_expires_at: null,
        channel_renewed_at: null,
      });
      expect(await scalar(client, "select public.google_refresh_token($1)", [id])).toBe("token-2");
    }));

  it("replaces a leftover secret with the same name", () =>
    rollback(async (client) => {
      const id = await addProfile(client, "leftover@example.com");
      await client.query("select vault.create_secret('stale', $1)", [`google_refresh_token_${id}`]);
      await connect(client, id, "fresh");
      expect(await scalar(client, "select public.google_refresh_token($1)", [id])).toBe("fresh");
    }));

  it("serialises parallel first connects for the same user", async () => {
    const setup = await pool.connect();
    const a = await pool.connect();
    const b = await pool.connect();
    let id = "";
    try {
      id = await addProfile(setup, "parallel@example.com");
      await a.query("begin");
      await b.query("begin");
      await connect(a, id, "from-a");
      const second = connect(b, id, "from-b");
      await new Promise((resolve) => setTimeout(resolve, 200));
      await a.query("commit");
      await second;
      await b.query("commit");
      expect(await scalar(setup, "select public.google_refresh_token($1)", [id])).toBe("from-b");
      expect(await scalar(setup, "select count(*)::int from vault.secrets where name = $1", [`google_refresh_token_${id}`])).toBe(1);
    } finally {
      await a.query("rollback").catch(() => {});
      await b.query("rollback").catch(() => {});
      if (id) {
        await setup.query("select public.google_connection_delete($1)", [id]);
        await setup.query("delete from public.profiles where id = $1", [id]);
        await setup.query("delete from auth.users where id = $1", [id]);
      }
      for (const c of [setup, a, b]) c.release();
    }
  });
});

describe("calendar_connections RLS", () => {
  it("lets the owner read safe columns and change only busy calendars", () =>
    rollback(async (client) => {
      const owner = await addProfile(client, "owner@example.com");
      const other = await addProfile(client, "other@example.com");
      await connect(client, owner);
      await connect(client, other);

      await actAs(client, "authenticated", owner);
      const { rows } = await client.query("select user_id, account_email, scopes, status from public.calendar_connections");
      expect(rows).toEqual([{ user_id: owner, account_email: "owner@example.com", scopes: ["calendar"], status: "ok" }]);
      for (const column of ["refresh_token_secret_id", "sync_token", "channel_token_hash", "channel_id"]) {
        expect((await sqlError(client, `select ${column} from public.calendar_connections`)).code, column).toBe("42501");
      }
      expect((await sqlError(client, "update public.calendar_connections set scopes = '{}'")).code).toBe("42501");
      expect((await sqlError(client, "delete from public.calendar_connections")).code).toBe("42501");
      expect((await sqlError(client, "insert into public.calendar_connections (user_id, account_email, refresh_token_secret_id) values ($1, 'x@example.com', gen_random_uuid())", [owner])).code).toBe("42501");

      await client.query("update public.calendar_connections set busy_calendar_ids = '{team@example.com}'");
      await client.query("reset role");
      const { rows: busy } = await client.query("select user_id, busy_calendar_ids from public.calendar_connections order by user_id = $1 desc", [owner]);
      expect(busy).toEqual([
        { user_id: owner, busy_calendar_ids: ["team@example.com"] },
        { user_id: other, busy_calendar_ids: [] },
      ]);
    }));

  it("hides connections from anon and deactivated owners", () =>
    rollback(async (client) => {
      const gone = await addProfile(client, "gone@example.com", false);
      await connect(client, gone);
      await client.query("savepoint s");
      await actAs(client, "authenticated", gone);
      expect((await client.query("select id from public.calendar_connections")).rowCount).toBe(0);
      await client.query("update public.calendar_connections set busy_calendar_ids = '{x}'");
      await client.query("rollback to savepoint s");
      expect(await scalar(client, "select busy_calendar_ids from public.calendar_connections where user_id = $1", [gone])).toEqual([]);
      await actAs(client, "anon");
      expect((await sqlError(client, "select id from public.calendar_connections")).code).toBe("42501");
    }));
});

describe("calendar sync claim and release", () => {
  it("runs one sync at a time and reports notifications that came in meanwhile", () =>
    rollback(async (client) => {
      const id = await addProfile(client, "sync@example.com");
      await connect(client, id);
      await actAs(client, "service_role");
      const claim = "select public.calendar_sync_claim($1)";
      const release = "select public.calendar_sync_release($1, $2, $3)";

      expect(await scalar(client, claim, [id])).toEqual({ sync_token: null, primary_calendar_id: "primary@example.com" });
      expect(await scalar(client, claim, [id])).toBeNull();
      expect(await scalar(client, release, [id, "s1", true])).toBe(true);
      expect(await scalar(client, claim, [id])).toEqual({ sync_token: "s1", primary_calendar_id: "primary@example.com" });
      expect(await scalar(client, release, [id, "s2", false])).toBe(false);
      expect(await scalar(client, "select sync_token from public.calendar_connections where user_id = $1", [id])).toBe("s1");

      // A crashed claim older than two minutes may be taken over.
      await client.query("update public.calendar_connections set sync_claimed_at = now() - interval '3 minutes' where user_id = $1", [id]);
      expect(await scalar(client, claim, [id])).toEqual({ sync_token: "s1", primary_calendar_id: "primary@example.com" });
    }));
});

describe("availability windows", () => {
  it("gives a new profile the default windows from settings", () =>
    rollback(async (client) => {
      const id = await addProfile(client, "defaults@example.com");
      const { rows } = await client.query(
        "select weekday, start_time::text, end_time::text from public.availability_windows where user_id = $1 order by weekday, start_time",
        [id],
      );
      expect(rows).toHaveLength(10);
      expect(rows.slice(0, 2)).toEqual([
        { weekday: 1, start_time: "09:00:00", end_time: "12:00:00" },
        { weekday: 1, start_time: "14:00:00", end_time: "17:00:00" },
      ]);

      await client.query(`update public.settings set value = '[{"weekday":7,"start":"10:00","end":"11:30"}]' where key = 'default_availability'`);
      const custom = await addProfile(client, "custom@example.com");
      expect(await scalar(client, "select count(*)::int from public.availability_windows where user_id = $1 and weekday = 7", [custom])).toBe(1);

      await client.query("delete from public.settings where key = 'default_availability'");
      const none = await addProfile(client, "none@example.com");
      expect(await scalar(client, "select count(*)::int from public.availability_windows where user_id = $1", [none])).toBe(0);
    }));

  it("lets members read the team and change only their own windows", () =>
    rollback(async (client) => {
      const me = await addProfile(client, "me@example.com");
      const other = await addProfile(client, "colleague@example.com");
      const otherWindow = await scalar<string>(client, "select id from public.availability_windows where user_id = $1 limit 1", [other]);

      await actAs(client, "authenticated", me);
      expect(await scalar(client, "select count(*)::int from public.availability_windows where user_id = any($1)", [[me, other]])).toBe(20);
      await client.query("insert into public.availability_windows (user_id, weekday, start_time, end_time) values ($1, 6, '10:00', '11:00')", [me]);
      expect((await sqlError(client, "insert into public.availability_windows (user_id, weekday, start_time, end_time) values ($1, 6, '10:00', '11:00')", [other])).code).toBe("42501");
      await client.query("delete from public.availability_windows where id = $1", [otherWindow]);
      expect((await sqlError(client, "update public.availability_windows set end_time = '18:00'")).code).toBe("42501");
      await client.query("reset role");
      expect(await scalar(client, "select count(*)::int from public.availability_windows where id = $1", [otherWindow])).toBe(1);
    }));

  it("hides windows from anon and deactivated members", () =>
    rollback(async (client) => {
      const gone = await addProfile(client, "inactive@example.com", false);
      await client.query("savepoint s");
      await actAs(client, "authenticated", gone);
      expect(await scalar(client, "select count(*)::int from public.availability_windows")).toBe(0);
      expect((await sqlError(client, "insert into public.availability_windows (user_id, weekday, start_time, end_time) values ($1, 6, '10:00', '11:00')", [gone])).code).toBe("42501");
      await client.query("rollback to savepoint s");
      await actAs(client, "anon");
      expect((await sqlError(client, "select id from public.availability_windows")).code).toBe("42501");
    }));

  it("enforces the 30-minute grid and start before end", () =>
    rollback(async (client) => {
      const id = await addProfile(client, "grid@example.com");
      for (const [start, end] of [["09:15", "10:00"], ["09:00", "10:00:30"], ["11:00", "10:00"], ["10:00", "10:00"]]) {
        const error = await sqlError(client, "insert into public.availability_windows (user_id, weekday, start_time, end_time) values ($1, 6, $2, $3)", [id, start, end]);
        expect(error.code, `${start}-${end}`).toBe("23514");
      }
    }));
});

describe("set_availability_day", () => {
  const call = "select public.set_availability_day($1::smallint, $2::jsonb)";

  it("replaces one day of the caller's windows", () =>
    rollback(async (client) => {
      const id = await addProfile(client, "day@example.com");
      await actAs(client, "authenticated", id);
      await client.query(call, [1, JSON.stringify([{ start: "08:00", end: "09:30" }, { start: "13:00", end: "15:00" }])]);
      await client.query(call, [2, "[]"]);
      const { rows } = await client.query(
        "select weekday, start_time::text from public.availability_windows where user_id = $1 and weekday in (1, 2, 3) order by weekday, start_time",
        [id],
      );
      expect(rows).toEqual([
        { weekday: 1, start_time: "08:00:00" },
        { weekday: 1, start_time: "13:00:00" },
        { weekday: 3, start_time: "09:00:00" },
        { weekday: 3, start_time: "14:00:00" },
      ]);
    }));

  it("rejects overlaps with 23514 and keeps the old windows", () =>
    rollback(async (client) => {
      const id = await addProfile(client, "overlap@example.com");
      await actAs(client, "authenticated", id);
      const error = await sqlError(client, call, [1, JSON.stringify([{ start: "08:00", end: "10:00" }, { start: "09:30", end: "11:00" }])]);
      expect(error.code).toBe("23514");
      expect(await scalar(client, "select count(*)::int from public.availability_windows where user_id = $1 and weekday = 1", [id])).toBe(2);
    }));

  it("rejects anon and deactivated members", () =>
    rollback(async (client) => {
      const gone = await addProfile(client, "off@example.com", false);
      await client.query("savepoint s");
      await actAs(client, "authenticated", gone);
      expect((await sqlError(client, call, [1, "[]"])).code).toBe("42501");
      await client.query("rollback to savepoint s");
      await actAs(client, "anon");
      expect((await sqlError(client, call, [1, "[]"])).code).toBe("42501");
    }));
});

describe("set_availability_week", () => {
  const call = "select public.set_availability_week($1::jsonb)";
  const week = (days: Record<number, { start: string; end: string }[]>) => JSON.stringify(Array.from({ length: 7 }, (_, i) => days[i + 1] ?? []));
  const windows = (client: Client, id: string) =>
    client.query("select weekday, start_time::text from public.availability_windows where user_id = $1 order by weekday, start_time", [id]);

  it("replaces all seven days at once", () =>
    rollback(async (client) => {
      const id = await addProfile(client, "week@example.com");
      await actAs(client, "authenticated", id);
      await client.query(call, [week({ 1: [{ start: "08:00", end: "09:30" }, { start: "13:00", end: "15:00" }], 7: [{ start: "10:00", end: "11:00" }] })]);
      expect((await windows(client, id)).rows).toEqual([
        { weekday: 1, start_time: "08:00:00" },
        { weekday: 1, start_time: "13:00:00" },
        { weekday: 7, start_time: "10:00:00" },
      ]);
      await client.query(call, [week({})]);
      expect((await windows(client, id)).rows).toEqual([]);
    }));

  it("leaves every day unchanged when one day overlaps", () =>
    rollback(async (client) => {
      const id = await addProfile(client, "weekfail@example.com");
      const before = (await windows(client, id)).rows;
      expect(before.length).toBeGreaterThan(0);
      await actAs(client, "authenticated", id);
      const error = await sqlError(client, call, [week({ 1: [{ start: "08:00", end: "09:00" }], 5: [{ start: "08:00", end: "10:00" }, { start: "09:30", end: "11:00" }] })]);
      expect(error.code).toBe("23514");
      expect((await windows(client, id)).rows).toEqual(before);
    }));

  it("only touches the caller's windows and rejects a wrong shape", () =>
    rollback(async (client) => {
      const me = await addProfile(client, "weekme@example.com");
      const other = await addProfile(client, "weekother@example.com");
      const othersBefore = (await windows(client, other)).rows;
      await actAs(client, "authenticated", me);
      await client.query(call, [week({})]);
      expect((await sqlError(client, call, ["[[], []]"])).code).toBe("22023");
      expect((await sqlError(client, call, ['{"a": 1}'])).code).toBe("22023");
      expect((await sqlError(client, call, [JSON.stringify([1, 2, 3, 4, 5, 6, 7])])).code).toBe("22023");
      await client.query("reset role");
      expect((await windows(client, other)).rows).toEqual(othersBefore);
    }));

  it("rejects anon and deactivated members", () =>
    rollback(async (client) => {
      const gone = await addProfile(client, "weekoff@example.com", false);
      await client.query("savepoint s");
      await actAs(client, "authenticated", gone);
      expect((await sqlError(client, call, [week({})])).code).toBe("42501");
      await client.query("rollback to savepoint s");
      await actAs(client, "anon");
      expect((await sqlError(client, call, [week({})])).code).toBe("42501");
    }));
});
