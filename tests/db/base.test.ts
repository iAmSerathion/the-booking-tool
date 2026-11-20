import { afterAll, describe, expect, it } from "vitest";
import { actAs, type Client, createAuthUser, pool, rollback } from "./db";

afterAll(() => pool.end());

type ProfileOptions = { isAdmin?: boolean; bookable?: boolean; active?: boolean; slug?: string };

// Creates an auth user plus profile as postgres. Call before actAs().
async function addProfile(client: Client, email: string, options: ProfileOptions = {}): Promise<string> {
  const id = await createAuthUser(client, email);
  await client.query(
    "insert into public.profiles (id, name, email, is_admin, bookable, active, slug) values ($1, $2, $3, $4, $5, $6, $7)",
    [id, email.split("@")[0], email, options.isAdmin ?? false, options.bookable ?? false, options.active ?? true, options.slug ?? null],
  );
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

describe("profiles table", () => {
  it("rejects reserved and malformed slugs", () =>
    rollback(async (client) => {
      const id = await addProfile(client, "slug@example.com");
      for (const slug of ["widget", "confirmed", "app", "Upper", "with space", "ümlaut"]) {
        const error = await sqlError(client, "update public.profiles set slug = $1 where id = $2", [slug, id]);
        expect(error.code, slug).toBe("23514");
      }
      await client.query("update public.profiles set slug = 'jane-doe-2' where id = $1", [id]);
    }));

  it("keeps booking limits in range", () =>
    rollback(async (client) => {
      const id = await addProfile(client, "limits@example.com");
      const bad = [
        ["buffer_minutes", 241],
        ["buffer_minutes", -1],
        ["min_notice_hours", 721],
        ["max_bookings_per_day", 0],
        ["max_bookings_per_day", 21],
      ] as const;
      for (const [column, value] of bad) {
        const error = await sqlError(client, `update public.profiles set ${column} = $1 where id = $2`, [value, id]);
        expect(error.code, `${column}=${value}`).toBe("23514");
      }
      await client.query(
        "update public.profiles set buffer_minutes = 240, min_notice_hours = 0, max_bookings_per_day = 20 where id = $1",
        [id],
      );
    }));

  it("treats emails as case-insensitive and unique", () =>
    rollback(async (client) => {
      await addProfile(client, "case@example.com");
      const error = await sqlError(client, "insert into public.profiles (id, name, email) values ($1, 'x', 'CASE@example.com')", [
        await createAuthUser(client, "case2@example.com"),
      ]);
      expect(error.code).toBe("23505");
      expect(await scalar(client, "select count(*)::int from public.profiles where email = 'Case@Example.com'")).toBe(1);
    }));

  it("sets updated_at on update", () =>
    rollback(async (client) => {
      const id = await addProfile(client, "touch@example.com");
      await client.query("alter table public.profiles disable trigger profiles_updated_at");
      await client.query("update public.profiles set updated_at = now() - interval '1 day' where id = $1", [id]);
      await client.query("alter table public.profiles enable trigger profiles_updated_at");
      await client.query("update public.profiles set timezone = 'UTC' where id = $1", [id]);
      expect(await scalar(client, "select updated_at = now() from public.profiles where id = $1", [id])).toBe(true);
    }));
});

describe("profiles RLS", () => {
  it("lets active members read the team, but not deactivated users or non-members", () =>
    rollback(async (client) => {
      const member = await addProfile(client, "member@example.com");
      const gone = await addProfile(client, "gone@example.com", { active: false });
      const stranger = await createAuthUser(client, "stranger@example.com");

      await client.query("savepoint s");
      await actAs(client, "authenticated", member);
      expect(await scalar(client, "select count(*)::int from public.profiles")).toBe(2);
      await client.query("rollback to savepoint s");

      await actAs(client, "authenticated", gone);
      expect(await scalar(client, "select count(*)::int from public.profiles")).toBe(0);
      await client.query("rollback to savepoint s");

      await actAs(client, "authenticated", stranger);
      expect(await scalar(client, "select count(*)::int from public.profiles")).toBe(0);
      await client.query("rollback to savepoint s");

      await actAs(client, "anon");
      expect((await sqlError(client, "select * from public.profiles")).code).toBe("42501");
    }));

  it("lets a member change only their own booking preferences", () =>
    rollback(async (client) => {
      const me = await addProfile(client, "me@example.com");
      const other = await addProfile(client, "other@example.com");
      await actAs(client, "authenticated", me);

      const own = await client.query(
        "update public.profiles set timezone = 'UTC', buffer_minutes = 30, min_notice_hours = 2, max_bookings_per_day = 5, meet_auto = false where id = $1",
        [me],
      );
      expect(own.rowCount).toBe(1);
      const others = await client.query("update public.profiles set timezone = 'UTC' where id = $1", [other]);
      expect(others.rowCount).toBe(0);

      for (const assignment of ["is_admin = true", "bookable = true", "active = false", "name = 'x'", "slug = 'me'", "email = 'x@example.com'"]) {
        const error = await sqlError(client, `update public.profiles set ${assignment} where id = $1`, [me]);
        expect(error.code, assignment).toBe("42501");
      }
      expect((await sqlError(client, "delete from public.profiles where id = $1", [me])).code).toBe("42501");
      expect(
        (await sqlError(client, "insert into public.profiles (id, name, email) values ($1, 'x', 'x@example.com')", [me])).code,
      ).toBe("42501");
    }));

  it("blocks a deactivated user from changing their row", () =>
    rollback(async (client) => {
      const gone = await addProfile(client, "inactive@example.com", { active: false });
      await actAs(client, "authenticated", gone);
      expect((await client.query("update public.profiles set timezone = 'UTC' where id = $1", [gone])).rowCount).toBe(0);
    }));

  it("lets service_role write profiles", () =>
    rollback(async (client) => {
      const id = await createAuthUser(client, "service@example.com");
      await actAs(client, "service_role");
      await client.query("insert into public.profiles (id, name, email, is_admin) values ($1, 'Admin', 'service@example.com', true)", [id]);
      expect(await scalar(client, "select is_admin from public.profiles where id = $1", [id])).toBe(true);
    }));
});

describe("membership functions", () => {
  it("answer is_active_profile and is_admin for each kind of user", () =>
    rollback(async (client) => {
      const users = {
        member: await addProfile(client, "plain@example.com"),
        admin: await addProfile(client, "admin@example.com", { isAdmin: true }),
        goneAdmin: await addProfile(client, "goneadmin@example.com", { isAdmin: true, active: false }),
        stranger: await createAuthUser(client, "nobody@example.com"),
      };
      const expected = {
        member: [true, false],
        admin: [true, true],
        goneAdmin: [false, false],
        stranger: [false, false],
      };
      await client.query("savepoint s");
      for (const [name, id] of Object.entries(users)) {
        await actAs(client, "authenticated", id);
        const { rows } = await client.query("select public.is_active_profile() as active, public.is_admin() as admin");
        expect([rows[0].active, rows[0].admin], name).toEqual(expected[name as keyof typeof expected]);
        await client.query("rollback to savepoint s");
      }
    }));

  it("are not executable by anon, and assert_is_admin is not executable by members", () =>
    rollback(async (client) => {
      const admin = await addProfile(client, "guard@example.com", { isAdmin: true });
      await client.query("savepoint s");
      await actAs(client, "anon");
      for (const fn of ["is_active_profile", "is_admin", "assert_is_admin"]) {
        const error = await sqlError(client, `select public.${fn}()`);
        expect(error.message, fn).toMatch(/permission denied/);
      }
      await client.query("rollback to savepoint s");
      await actAs(client, "authenticated", admin);
      expect((await sqlError(client, "select public.assert_is_admin()")).message).toMatch(/permission denied/);
    }));
});

describe("set_slug", () => {
  it("lets an admin change a slug and maps errors to stable codes", () =>
    rollback(async (client) => {
      const admin = await addProfile(client, "slugadmin@example.com", { isAdmin: true, slug: "taken" });
      const member = await addProfile(client, "slugmember@example.com");
      await actAs(client, "authenticated", admin);

      await client.query("select public.set_slug($1, 'new-slug')", [member]);
      expect(await scalar(client, "select slug from public.profiles where id = $1", [member])).toBe("new-slug");
      await client.query("select public.set_slug($1, null)", [member]);
      expect(await scalar(client, "select slug from public.profiles where id = $1", [member])).toBe(null);

      expect((await sqlError(client, "select public.set_slug($1, 'taken')", [member])).code).toBe("23505");
      expect((await sqlError(client, "select public.set_slug($1, 'widget')", [member])).code).toBe("23514");
      expect((await sqlError(client, "select public.set_slug(gen_random_uuid(), 'free')")).code).toBe("P0002");
    }));

  it("rejects members, deactivated admins, non-members, service_role and anon", () =>
    rollback(async (client) => {
      const member = await addProfile(client, "nonadmin@example.com");
      const goneAdmin = await addProfile(client, "formeradmin@example.com", { isAdmin: true, active: false });
      const stranger = await createAuthUser(client, "outsider@example.com");
      await client.query("savepoint s");

      for (const id of [member, goneAdmin, stranger]) {
        await actAs(client, "authenticated", id);
        const error = await sqlError(client, "select public.set_slug($1, 'hijack')", [member]);
        expect(error).toEqual({ code: "42501", message: "Only admins can change this." });
        await client.query("rollback to savepoint s");
      }

      await actAs(client, "service_role");
      expect((await sqlError(client, "select public.set_slug($1, 'hijack')", [member])).message).toBe("Only admins can change this.");
      await client.query("rollback to savepoint s");

      await actAs(client, "anon");
      expect((await sqlError(client, "select public.set_slug($1, 'hijack')", [member])).message).toMatch(/permission denied/);
      await client.query("rollback to savepoint s");
      expect(await scalar(client, "select slug from public.profiles where id = $1", [member])).toBe(null);
    }));
});

describe("settings", () => {
  it("seeds only neutral defaults", () =>
    rollback(async (client) => {
      const { rows } = await client.query("select key, value from public.settings where key in ('slot_horizon_days', 'website_mode') order by key");
      expect(rows).toEqual([
        { key: "slot_horizon_days", value: 14 },
        { key: "website_mode", value: "round_robin" },
      ]);
    }));

  it("is readable by active members only and writable by service_role only", () =>
    rollback(async (client) => {
      const member = await addProfile(client, "reader@example.com", { isAdmin: true });
      const gone = await addProfile(client, "exreader@example.com", { active: false });
      await client.query("savepoint s");

      await actAs(client, "authenticated", member);
      expect(await scalar(client, "select count(*)::int from public.settings where key in ('slot_horizon_days', 'website_mode')")).toBe(2);
      expect((await sqlError(client, "update public.settings set value = '30' where key = 'slot_horizon_days'")).code).toBe("42501");
      expect((await sqlError(client, "insert into public.settings (key, value) values ('brand', '{}')")).code).toBe("42501");
      expect((await sqlError(client, "delete from public.settings")).code).toBe("42501");
      await client.query("rollback to savepoint s");

      await actAs(client, "authenticated", gone);
      expect(await scalar(client, "select count(*)::int from public.settings")).toBe(0);
      await client.query("rollback to savepoint s");

      await actAs(client, "anon");
      expect((await sqlError(client, "select * from public.settings")).code).toBe("42501");
      await client.query("rollback to savepoint s");

      await actAs(client, "service_role");
      await client.query(
        "insert into public.settings (key, value) values ('website_mode', '\"person\"') on conflict (key) do update set value = excluded.value",
      );
      expect(await scalar(client, "select value from public.settings where key = 'website_mode'")).toBe("person");
    }));
});
