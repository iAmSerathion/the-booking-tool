import { afterAll, describe, expect, it } from "vitest";
import { actAs, type Client, createAuthUser, pool, rollback } from "./db";

afterAll(() => pool.end());

type ProfileOptions = { isAdmin?: boolean; bookable?: boolean; active?: boolean };

// Creates an auth user plus profile as postgres. Call before actAs().
async function addProfile(client: Client, email: string, options: ProfileOptions = {}): Promise<string> {
  const id = await createAuthUser(client, email);
  await client.query("insert into public.profiles (id, name, email, is_admin, bookable, active) values ($1, $2, $3, $4, $5, $6)", [
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

// Runs fn as the given role, then returns to postgres; its writes stay visible to the rest of the test.
async function as<T>(client: Client, role: "anon" | "authenticated" | "service_role", user: string | undefined, fn: () => Promise<T>) {
  await actAs(client, role, user);
  try {
    return await fn();
  } finally {
    await client.query("reset role");
  }
}

const inDays = (days: number, hour = 10) => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

// The times addBooking gave each booking, for the plans below.
const bookingTimes = new Map<string, { starts_at: string; ends_at: string }>();

async function addBooking(client: Client, host: string, starts: string, state: "booked" | "cancelled" = "booked"): Promise<string> {
  const id = await scalar<string>(
    client,
    `insert into public.bookings (event_type_id, host_id, starts_at, ends_at, booked_via, invitee_name, invitee_email,
       google_event_id, meet_url, guest_responses, state, cancelled_by)
     values ((select value #>> '{}' from public.settings where key = 'default_event_type_id')::uuid, $1, $2::timestamptz,
       $2::timestamptz + interval '30 minutes', 'page', 'Ada Example', 'ada@example.com', 'old-evt', 'https://meet.example.com/old',
       '{"ada@example.com": "accepted"}', $3::public.booking_state, case when $3::text = 'cancelled' then 'host'::public.booking_cancelled_by end)
     returning id`,
    [host, starts, state],
  );
  bookingTimes.set(id, { starts_at: starts, ends_at: new Date(Date.parse(starts) + 30 * 60_000).toISOString() });
  return id;
}

async function addWidget(client: Client, ...hosts: string[]): Promise<string> {
  const id = await scalar<string>(
    client,
    `insert into public.booking_widgets (name, mode, event_type_id)
     values ('Widget', 'round_robin', (select value #>> '{}' from public.settings where key = 'default_event_type_id')::uuid)
     returning id`,
  );
  for (const host of hosts) await client.query("insert into public.booking_widget_hosts (widget_id, user_id) values ($1, $2)", [id, host]);
  return id;
}

async function team(client: Client) {
  return {
    admin: await addProfile(client, "admin@example.com", { isAdmin: true }),
    member: await addProfile(client, "member@example.com"),
    successor: await addProfile(client, "successor@example.com"),
    retiredAdmin: await addProfile(client, "retired@example.com", { isAdmin: true, active: false }),
  };
}

const rightsSql = "select public.set_person_rights($1, $2::jsonb)";
const reactivateSql = "select public.reactivate_profile($1)";
const inviteSql = "select public.invite_profile($1, $2, $3::jsonb)";
const deactivateSql = "select public.deactivate_profile($1, $2, $3, $4::jsonb)";
// Like lib/team/deactivate.ts: each booking with the times the plan was built from and its new event id.
const plan = (...bookings: { id: string; google_event_id?: string; meet_url?: string; starts_at?: string }[]) =>
  JSON.stringify({ bookings: bookings.map((b) => ({ google_event_id: `new-${b.id}`, ...bookingTimes.get(b.id), ...b })) });

describe("team function permissions", () => {
  it("lets only active admins change rights or reactivate", () =>
    rollback(async (client) => {
      const { admin, member, retiredAdmin } = await team(client);
      const gone = await addProfile(client, "gone@example.com", { active: false });
      for (const [role, user] of [
        ["anon", undefined],
        ["authenticated", member],
        ["authenticated", retiredAdmin],
      ] as const) {
        await as(client, role, user, async () => {
          expect((await sqlError(client, rightsSql, [member, '{"is_admin": true}'])).code, `${role} ${user}`).toBe("42501");
          expect((await sqlError(client, reactivateSql, [gone])).code, `${role} ${user}`).toBe("42501");
        });
      }
      await as(client, "authenticated", admin, async () => {
        await client.query(rightsSql, [member, '{"is_admin": true}']);
        await client.query(reactivateSql, [gone]);
      });
    }));

  it("keeps invite and deactivate to the service role with an active admin as actor", () =>
    rollback(async (client) => {
      const { admin, member, successor, retiredAdmin } = await team(client);
      const newUser = await createAuthUser(client, "new@example.com");
      const invite = [newUser, admin, '{"name": "New", "email": "new@example.com"}'];
      const deactivate = [member, successor, admin, plan()];
      for (const [role, user] of [
        ["anon", undefined],
        ["authenticated", admin],
      ] as const) {
        await as(client, role, user, async () => {
          expect((await sqlError(client, inviteSql, invite)).code, role).toBe("42501");
          expect((await sqlError(client, deactivateSql, deactivate)).code, role).toBe("42501");
        });
      }
      await as(client, "service_role", undefined, async () => {
        for (const actor of [member, retiredAdmin, newUser]) {
          expect((await sqlError(client, inviteSql, [newUser, actor, invite[2]])).code).toBe("42501");
          expect((await sqlError(client, deactivateSql, [member, successor, actor, plan()])).code).toBe("42501");
        }
      });
    }));

  it("does not let members change rights, active or slug on the table directly", () =>
    rollback(async (client) => {
      const { member } = await team(client);
      await as(client, "authenticated", member, async () => {
        for (const column of ["is_admin = true", "bookable = false", "active = false", "slug = 'x'"]) {
          expect((await sqlError(client, `update public.profiles set ${column} where id = $1`, [member])).code, column).toBe("42501");
        }
      });
    }));
});

describe("set_person_rights", () => {
  it("changes only the keys present", () =>
    rollback(async (client) => {
      const { admin, member } = await team(client);
      await as(client, "authenticated", admin, async () => {
        await client.query(rightsSql, [member, '{"is_admin": true}']);
        await client.query(rightsSql, [member, '{}']);
      });
      const { rows } = await client.query("select is_admin, bookable from public.profiles where id = $1", [member]);
      expect(rows[0]).toEqual({ is_admin: true, bookable: true });
      await as(client, "authenticated", admin, () => client.query(rightsSql, [member, '{"bookable": false}']));
      const after = await client.query("select is_admin, bookable from public.profiles where id = $1", [member]);
      expect(after.rows[0]).toEqual({ is_admin: true, bookable: false });
    }));

  it("refuses an unknown member and removing the last admin", () =>
    rollback(async (client) => {
      const { admin } = await team(client);
      await client.query("update public.profiles set is_admin = false where id <> $1", [admin]); // the seed has an admin
      await as(client, "authenticated", admin, async () => {
        expect((await sqlError(client, rightsSql, ["00000000-0000-0000-0000-000000000001", "{}"])).code).toBe("P0002");
        const last = await sqlError(client, rightsSql, [admin, '{"is_admin": false}']);
        expect(last.code).toBe("P0002");
        expect(last.message).toMatch(/admin/);
      });
    }));

  it("refuses to make a widget host or the website person unbookable", () =>
    rollback(async (client) => {
      const { admin, member, successor } = await team(client);
      await addWidget(client, member);
      await client.query(
        `insert into public.settings (key, value) values ('website_mode', '"person"'), ('website_person_id', to_jsonb($1::text))
         on conflict (key) do update set value = excluded.value`,
        [successor],
      );
      await as(client, "authenticated", admin, async () => {
        for (const id of [member, successor]) expect((await sqlError(client, rightsSql, [id, '{"bookable": false}'])).code).toBe("P0002");
      });
      // In round robin mode the stored person does not matter.
      await client.query("update public.settings set value = '\"round_robin\"' where key = 'website_mode'");
      await as(client, "authenticated", admin, () => client.query(rightsSql, [successor, '{"bookable": false}']));
    }));
});

describe("reactivate_profile", () => {
  it("reactivates an inactive member and refuses an active one", () =>
    rollback(async (client) => {
      const { admin, member, retiredAdmin } = await team(client);
      await as(client, "authenticated", admin, async () => {
        await client.query(reactivateSql, [retiredAdmin]);
        expect((await sqlError(client, reactivateSql, [member])).code).toBe("P0002");
      });
      expect(await scalar(client, "select active from public.profiles where id = $1", [retiredAdmin])).toBe(true);
    }));
});

describe("invite_profile", () => {
  it("creates a profile with trimmed values, defaults and starting availability", () =>
    rollback(async (client) => {
      const { admin } = await team(client);
      const id = await createAuthUser(client, "invitee@example.com");
      await as(client, "service_role", undefined, async () => {
        await client.query(inviteSql, [id, admin, '{"name": " Jane Doe ", "email": " Jane@Example.com ", "slug": "jane"}']);
      });
      const { rows } = await client.query("select name, email::text, slug, is_admin, bookable, active from public.profiles where id = $1", [id]);
      expect(rows[0]).toEqual({ name: "Jane Doe", email: "jane@example.com", slug: "jane", is_admin: false, bookable: false, active: true });
      expect(await scalar(client, "select count(*)::int from public.availability_windows where user_id = $1", [id])).toBe(10);
    }));

  it("takes rights from the input", () =>
    rollback(async (client) => {
      const { admin } = await team(client);
      const id = await createAuthUser(client, "rights@example.com");
      await as(client, "service_role", undefined, () =>
        client.query(inviteSql, [id, admin, '{"name": "R", "email": "rights@example.com", "is_admin": true, "bookable": true, "slug": ""}']),
      );
      const { rows } = await client.query("select slug, is_admin, bookable from public.profiles where id = $1", [id]);
      expect(rows[0]).toEqual({ slug: null, is_admin: true, bookable: true });
    }));

  it("refuses missing names, duplicates and reserved slugs", () =>
    rollback(async (client) => {
      const { admin } = await team(client);
      await client.query("update public.profiles set slug = 'taken' where id = $1", [admin]);
      const id = await createAuthUser(client, "dupe@example.com");
      await as(client, "service_role", undefined, async () => {
        for (const [input, code] of [
          ['{"name": " ", "email": "dupe@example.com"}', "23514"],
          ['{"name": "D"}', "23514"],
          ['{"name": "D", "email": "ADMIN@example.com"}', "23505"],
          ['{"name": "D", "email": "dupe@example.com", "slug": "taken"}', "23505"],
          ['{"name": "D", "email": "dupe@example.com", "slug": "widget"}', "23514"],
        ] as const) {
          expect((await sqlError(client, inviteSql, [id, admin, input])).code, input).toBe(code);
        }
      });
    }));
});

describe("deactivate_profile", () => {
  it("hands bookings, widgets and the website person to the successor", () =>
    rollback(async (client) => {
      const { admin, member, successor } = await team(client);
      const future = await addBooking(client, member, inDays(3));
      const future2 = await addBooking(client, member, inDays(4));
      const past = await addBooking(client, member, inDays(-2));
      const cancelled = await addBooking(client, member, inDays(5), "cancelled");
      const solo = await addWidget(client, member);
      const shared = await addWidget(client, member, successor);
      await client.query("insert into public.settings (key, value) values ('website_person_id', to_jsonb($1::text))", [member]);
      await client.query(
        "insert into public.slot_holds (host_id, starts_at, ends_at) values ($1, $2::timestamptz, $2::timestamptz + interval '30 minutes')",
        [member, inDays(6)],
      );

      await as(client, "service_role", undefined, async () => {
        await client.query(deactivateSql, [
          member,
          successor,
          admin,
          plan({ id: future, meet_url: "https://meet.example.com/new" }, { id: future2 }),
        ]);
        const { rows } = await client.query(
          "select id, host_id, google_event_id, meet_url, guest_responses from public.bookings where id = any($1) order by starts_at",
          [[future, future2, past, cancelled]],
        );
        expect(rows).toEqual([
          { id: past, host_id: member, google_event_id: "old-evt", meet_url: "https://meet.example.com/old", guest_responses: { "ada@example.com": "accepted" } },
          { id: future, host_id: successor, google_event_id: `new-${future}`, meet_url: "https://meet.example.com/new", guest_responses: {} },
          // No link in the plan (Google had not made the Meet yet): the departed member's old link does not stay.
          { id: future2, host_id: successor, google_event_id: `new-${future2}`, meet_url: null, guest_responses: {} },
          { id: cancelled, host_id: member, google_event_id: "old-evt", meet_url: "https://meet.example.com/old", guest_responses: { "ada@example.com": "accepted" } },
        ]);
        const outbox = await client.query(
          "select booking_id, payload ->> 'host_id' as host, payload ->> 'previous_host_id' as previous from public.booking_outbox where type = 'booking.host_changed' order by booking_id",
        );
        expect(outbox.rows).toEqual(
          [future, future2].sort().map((id) => ({ booking_id: id, host: successor, previous: member })),
        );
        const hosts = await client.query("select widget_id, user_id from public.booking_widget_hosts where widget_id = any($1)", [[solo, shared]]);
        expect(hosts.rows).toHaveLength(2);
        expect(hosts.rows.every((r) => r.user_id === successor)).toBe(true);
        expect(await scalar(client, "select value #>> '{}' from public.settings where key = 'website_person_id'")).toBe(successor);
        expect(await scalar(client, "select active from public.profiles where id = $1", [member])).toBe(false);
        expect(await scalar(client, "select count(*)::int from public.slot_holds where host_id = $1", [member])).toBe(0);
      });
    }));

  it("leaves the link metadata of a handed-over booking readable for the successor through booking_link_metadata", () =>
    rollback(async (client) => {
      const { admin, member, successor, retiredAdmin } = await team(client);
      const other = await addProfile(client, "other@example.com");
      const booking = await addBooking(client, member, inDays(3));
      await client.query(
        `with l as (
           insert into public.booking_links (token_hash, host_id, event_type_id, metadata)
           select repeat('a', 64), host_id, event_type_id, '{"campaign": "spring"}' from public.bookings where id = $1
           returning id)
         update public.bookings set link_id = (select id from l) where id = $1`,
        [booking],
      );
      await as(client, "service_role", undefined, () => client.query(deactivateSql, [member, successor, admin, plan({ id: booking })]));

      const metadataSql = "select booking_id, metadata from public.booking_link_metadata($1)";
      for (const viewer of [successor, admin]) {
        await as(client, "authenticated", viewer, async () => {
          // The link itself stays with the deactivated member, so the successor cannot read it directly.
          if (viewer === successor) expect((await client.query("select id from public.booking_links")).rows).toEqual([]);
          expect((await client.query(metadataSql, [[booking]])).rows).toEqual([{ booking_id: booking, metadata: { campaign: "spring" } }]);
        });
      }
      for (const viewer of [other, retiredAdmin, member]) {
        await as(client, "authenticated", viewer, async () => expect((await client.query(metadataSql, [[booking]])).rows, viewer).toEqual([]));
      }
      await as(client, "anon", undefined, async () => expect((await sqlError(client, metadataSql, [[booking]])).code).toBe("42501"));
    }));

  it("refuses bad successors, self, an inactive member and a stale or incomplete plan", () =>
    rollback(async (client) => {
      const { admin, member, successor, retiredAdmin } = await team(client);
      const unbookable = await addProfile(client, "unbookable@example.com", { bookable: false });
      const booking = await addBooking(client, member, inDays(3));
      const other = await addBooking(client, successor, inDays(3));
      const idle = await addProfile(client, "idle@example.com");
      await as(client, "service_role", undefined, async () => {
        for (const [args, code] of [
          [[admin, successor, admin, plan()], "P0002"],
          [[retiredAdmin, successor, admin, plan()], "P0002"],
          [[member, member, admin, plan({ id: booking })], "P0002"],
          [[member, retiredAdmin, admin, plan({ id: booking })], "P0002"],
          [[member, unbookable, admin, plan({ id: booking })], "P0002"],
          [[member, successor, admin, plan()], "P0002"],
          [[member, successor, admin, plan({ id: booking }, { id: other })], "P0002"],
          // Rescheduled after the plan was built (the new event would be at the old time).
          [[member, successor, admin, plan({ id: booking, starts_at: inDays(4) })], "P0002"],
          [[member, successor, admin, JSON.stringify({ bookings: [{ id: booking, google_event_id: "new" }] })], "P0002"],
          [[member, successor, admin, plan({ id: booking, google_event_id: "" })], "23514"],
        ] as const) {
          expect((await sqlError(client, deactivateSql, [...args])).code, JSON.stringify(args)).toBe(code);
        }
        // Nothing to take over: an unbookable successor is fine.
        await client.query(deactivateSql, [idle, unbookable, admin, plan()]);
      });
    }));
});

describe("last admin under concurrency", () => {
  // Two admins act on each other at the same time. The second call passes its admin check, then waits on the
  // 'team:admins' lock and must fail once the first commits; without the lock both could pass and leave no admin.
  async function race(call: (self: string, other: string) => [string, unknown[]], role: "authenticated" | "service_role") {
    const setup = await pool.connect();
    const a = await pool.connect();
    const b = await pool.connect();
    const ids: string[] = [];
    // The race needs these two to be the only admins; seeded admins are demoted for the test and restored after.
    const { rows: others } = await setup.query<{ id: string }>("update public.profiles set is_admin = false where is_admin returning id");
    try {
      expect(await scalar(setup, "select count(*)::int from public.profiles where active and is_admin")).toBe(0);
      ids.push(await addProfile(setup, "race-a@example.com", { isAdmin: true }));
      ids.push(await addProfile(setup, "race-b@example.com", { isAdmin: true }));
      await a.query("begin");
      await actAs(a, role, ids[0]);
      await a.query(...call(ids[0], ids[1]));

      await b.query("begin");
      await actAs(b, role, ids[1]);
      const pidB = await scalar<number>(b, "select pg_backend_pid()");
      const second = b.query(...call(ids[1], ids[0])).then(
        () => "ok",
        (error: { code: string }) => error.code,
      );
      let waiting = false;
      for (let i = 0; i < 50 && !waiting; i++) {
        const { rows } = await setup.query("select wait_event_type, wait_event from pg_stat_activity where pid = $1", [pidB]);
        waiting = rows[0]?.wait_event_type === "Lock" && rows[0]?.wait_event === "advisory";
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);

      await a.query("commit");
      expect(await second).toBe("P0002");
      await b.query("rollback");
      expect(await scalar(setup, "select count(*)::int from public.profiles where id = any($1) and active and is_admin", [ids])).toBe(1);
    } finally {
      await a.query("rollback").catch(() => {});
      await b.query("rollback").catch(() => {});
      for (const id of ids) await removeProfile(setup, id);
      await setup.query("update public.profiles set is_admin = true where id = any($1)", [others.map((row) => row.id)]);
      for (const c of [setup, a, b]) c.release();
    }
  }

  it("lets only one of two mutual demotions through", () => race((_self, other) => [rightsSql, [other, '{"is_admin": false}']], "authenticated"));

  it("lets only one of two mutual deactivations through", () =>
    race((self, other) => [deactivateSql, [other, self, self, plan()]], "service_role"));
});

const admitSql = "select public.admit_profile($1, $2)";

describe("admit_profile", () => {
  it("is for the service role only", () =>
    rollback(async (client) => {
      const id = await createAuthUser(client, "new@example.com");
      for (const [role, user] of [
        ["anon", undefined],
        ["authenticated", id],
      ] as const) {
        await as(client, role, user, async () => expect((await sqlError(client, admitSql, [id, false])).code, role).toBe("42501"));
      }
    }));

  it("creates a member from the verified auth user with starting availability", () =>
    rollback(async (client) => {
      const id = await createAuthUser(client, "Jane.Doe@Example.com");
      await client.query(`update auth.users set raw_user_meta_data = '{"full_name": " Jane Doe "}' where id = $1`, [id]);
      await as(client, "service_role", undefined, () => client.query(admitSql, [id, false]));
      const { rows } = await client.query("select name, email::text, is_admin, bookable, active from public.profiles where id = $1", [id]);
      expect(rows[0]).toEqual({ name: "Jane Doe", email: "jane.doe@example.com", is_admin: false, bookable: false, active: true });
      expect(await scalar(client, "select count(*)::int from public.availability_windows where user_id = $1", [id])).toBe(10);
    }));

  it("creates the first admin only while no active admin exists", () =>
    rollback(async (client) => {
      const first = await createAuthUser(client, "first@example.com");
      const second = await createAuthUser(client, "second@example.com");
      // A fresh install: the seeded admin is not there (an inactive admin does not count).
      await client.query("update public.profiles set active = false where is_admin");
      await as(client, "service_role", undefined, () => client.query(admitSql, [first, true]));
      expect(await scalar(client, "select is_admin from public.profiles where id = $1", [first])).toBe(true);
      await as(client, "service_role", undefined, async () => expect((await sqlError(client, admitSql, [second, true])).code).toBe("42501"));
      expect(await scalar(client, "select count(*)::int from public.profiles where id = $1", [second])).toBe(0);
    }));

  it("refuses the seeded install, existing profiles and unknown users", () =>
    rollback(async (client) => {
      const id = await createAuthUser(client, "late@example.com");
      await as(client, "service_role", undefined, async () => {
        expect((await sqlError(client, admitSql, [id, true])).code).toBe("42501");
        await client.query(admitSql, [id, false]);
        expect((await sqlError(client, admitSql, [id, false])).code).toBe("23505");
        expect((await sqlError(client, admitSql, ["00000000-0000-4000-8000-0000000000ff", false])).code).toBe("P0002");
      });
    }));

  it("refuses an email that another profile already has", () =>
    rollback(async (client) => {
      const id = await createAuthUser(client, "ADMIN.demo@example.com");
      await as(client, "service_role", undefined, async () => expect((await sqlError(client, admitSql, [id, false])).code).toBe("23505"));
    }));

  // Two first sign-ins at once: the second waits on 'team:admins' and must fail once the first commits.
  it("lets only one of two concurrent first admins through", async () => {
    const setup = await pool.connect();
    const a = await pool.connect();
    const b = await pool.connect();
    const ids: string[] = [];
    const { rows: admins } = await setup.query<{ id: string }>("update public.profiles set active = false where is_admin and active returning id");
    try {
      ids.push(await createAuthUser(setup, "race-first@example.com"), await createAuthUser(setup, "race-second@example.com"));
      await a.query("begin");
      await actAs(a, "service_role");
      await a.query(admitSql, [ids[0], true]);

      await b.query("begin");
      await actAs(b, "service_role");
      const pidB = await scalar<number>(b, "select pg_backend_pid()");
      const second = b.query(admitSql, [ids[1], true]).then(
        () => "ok",
        (error: { code: string }) => error.code,
      );
      let waiting = false;
      for (let i = 0; i < 50 && !waiting; i++) {
        const { rows } = await setup.query("select wait_event_type, wait_event from pg_stat_activity where pid = $1", [pidB]);
        waiting = rows[0]?.wait_event_type === "Lock" && rows[0]?.wait_event === "advisory";
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);

      await a.query("commit");
      expect(await second).toBe("42501");
      await b.query("rollback");
      expect(await scalar(setup, "select count(*)::int from public.profiles where id = any($1) and is_admin", [ids])).toBe(1);
    } finally {
      await a.query("rollback").catch(() => {});
      await b.query("rollback").catch(() => {});
      await setup.query("delete from public.availability_windows where user_id = any($1)", [ids]);
      for (const id of ids) await removeProfile(setup, id);
      await setup.query("update public.profiles set active = true where id = any($1)", [admins.map((row) => row.id)]);
      for (const c of [setup, a, b]) c.release();
    }
  });
});
