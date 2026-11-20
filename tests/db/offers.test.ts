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
    options.bookable ?? false,
    options.active ?? true,
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

const saveEventType = "select public.save_event_type($1, $2, $3, $4, $5, $6) as id";
const saveWidget = "select public.save_booking_widget($1, $2, $3, $4, $5, $6) as id";
const insertLink = "insert into public.booking_links (token_hash, host_id, event_type_id) values ($1, $2, $3)";
const hash = (n: number) => n.toString(16).padStart(64, "0");

async function defaultEventType(client: Client): Promise<string> {
  return scalar(client, "select value #>> '{}' from public.settings where key = 'default_event_type_id'");
}

// Admin, bookable member, plain member and the seeded event type, created as postgres.
async function team(client: Client) {
  const admin = await addProfile(client, "admin@example.com", { isAdmin: true, bookable: true });
  const host = await addProfile(client, "host@example.com", { bookable: true });
  const member = await addProfile(client, "member@example.com");
  const eventType = await defaultEventType(client);
  return { admin, host, member, eventType };
}

describe("seed", () => {
  it("creates an active default event type", () =>
    rollback(async (client) => {
      const id = await defaultEventType(client);
      const { rows } = await client.query("select slug, duration_minutes, active from public.event_types where id = $1", [id]);
      expect(rows).toEqual([{ slug: "meeting", duration_minutes: 30, active: true }]);
    }));
});

describe("event_type_questions_valid", () => {
  const valid = (client: Client, value: unknown) =>
    scalar<boolean>(client, "select public.event_type_questions_valid($1::jsonb)", [JSON.stringify(value)]);

  it("accepts well-formed questions", () =>
    rollback(async (client) => {
      expect(await valid(client, [])).toBe(true);
      expect(
        await valid(client, [
          { id: "goal", label: "What is your goal?", type: "choice", choices: ["Growth", "Cost"], required: true },
          { id: "tools", label: "Tools", type: "multi", choices: ["A"] },
          { id: "notes", label: "Anything else?", type: "text", required: false },
        ]),
      ).toBe(true);
    }));

  it("rejects malformed questions", () =>
    rollback(async (client) => {
      const q = { id: "q", label: "Q", type: "text" };
      const bad: unknown[] = [
        {},
        "x",
        [1],
        [{ ...q, id: "Upper" }],
        [{ ...q, id: "" }],
        [{ ...q, label: "  " }],
        [{ ...q, label: "x".repeat(201) }],
        [{ ...q, type: "date" }],
        [{ ...q, required: "yes" }],
        [{ ...q, type: "choice" }],
        [{ ...q, type: "choice", choices: [] }],
        [{ ...q, type: "multi", choices: [""] }],
        [{ ...q, type: "multi", choices: [1] }],
        [{ ...q, type: "choice", choices: Array.from({ length: 31 }, (_, i) => `c${i}`) }],
        [q, q],
        Array.from({ length: 21 }, (_, i) => ({ ...q, id: `q${i}` })),
      ];
      for (const value of bad) expect(await valid(client, value), JSON.stringify(value)).toBe(false);
    }));
});

describe("embed_origins_valid", () => {
  it("allows https origins and http only for localhost", () =>
    rollback(async (client) => {
      const valid = (origins: string[]) => scalar<boolean>(client, "select public.embed_origins_valid($1)", [origins]);
      expect(await valid(["https://www.example.com", "https://example.com:8443", "http://localhost:3000", "http://127.0.0.1"])).toBe(
        true,
      );
      for (const origin of [
        "http://www.example.com",
        "https://example.com/",
        "https://example.com/path",
        "https://Example.com",
        "https://localhost",
        "https://-bad.example.com",
        "javascript:alert(1)",
        "*",
        "https://*.example.com",
      ]) {
        expect(await valid([origin]), origin).toBe(false);
      }
      expect(await valid(Array.from({ length: 21 }, (_, i) => `https://s${i}.example.com`))).toBe(false);
    }));
});

describe("admin functions", () => {
  it("are closed to anon, plain members and deactivated admins", () =>
    rollback(async (client) => {
      const { admin, host, member, eventType } = await team(client);
      const retired = await addProfile(client, "retired@example.com", { isAdmin: true, active: false });
      const widget = await scalar<string>(
        client,
        "insert into public.booking_widgets (name, event_type_id) values ('W', $1) returning id",
        [eventType],
      );
      const calls = [
        [saveEventType, [null, "intro", "Intro", null, 30, "[]"]],
        ["select public.set_event_type_active($1, false)", [eventType]],
        [saveWidget, [null, "W", "person", [host], eventType, []]],
        ["select public.set_booking_widget_active($1, false)", [widget]],
        ["select public.set_website_bookings('person', $1)", [admin]],
      ] as const;
      for (const [role, user] of [
        ["anon", undefined],
        ["authenticated", member],
        ["authenticated", host],
        ["authenticated", retired],
      ] as const) {
        await client.query("savepoint as_role");
        await actAs(client, role, user);
        for (const [sql, params] of calls) {
          expect((await sqlError(client, sql, [...params])).code, `${role} ${user}: ${sql}`).toBe("42501");
        }
        await client.query("rollback to savepoint as_role");
      }
    }));
});

describe("event types", () => {
  it("admins create and update them; members read them", () =>
    rollback(async (client) => {
      const { admin, member } = await team(client);
      await actAs(client, "authenticated", admin);
      const questions = [{ id: "goal", label: "Goal", type: "choice", choices: ["A", "B"], required: true }];
      const id = await scalar<string>(client, saveEventType, [null, " Intro-Call ", " Intro ", "  ", 45, JSON.stringify(questions)]);
      let row = (await client.query("select * from public.event_types where id = $1", [id])).rows[0];
      expect(row).toMatchObject({ slug: "intro-call", title: "Intro", description: null, duration_minutes: 45, questions });
      expect(row.created_by).toBe(admin);

      await client.query(saveEventType, [id, "intro", "Intro call", "Short", 60, null]);
      row = (await client.query("select * from public.event_types where id = $1", [id])).rows[0];
      expect(row).toMatchObject({ slug: "intro", title: "Intro call", description: "Short", duration_minutes: 60, questions: [] });

      await client.query("reset role");
      await actAs(client, "authenticated", member);
      expect(await scalar(client, "select count(*)::int from public.event_types where id = any($1)", [[id, await defaultEventType(client)]])).toBe(2);
      expect((await sqlError(client, "update public.event_types set title = 'x'")).code).toBe("42501");
      expect((await sqlError(client, "insert into public.event_types (slug, title, duration_minutes) values ('x', 'x', 30)")).code).toBe(
        "42501",
      );
    }));

  it("rejects invalid input with readable 23514 or P0002 errors", () =>
    rollback(async (client) => {
      const { admin } = await team(client);
      await actAs(client, "authenticated", admin);
      const bad = [
        [null, "x", "", null, 30, "[]"],
        [null, "Bad Slug", "X", null, 30, "[]"],
        [null, "a--b", "X", null, 30, "[]"],
        [null, "x", "X", null, 7, "[]"],
        [null, "x", "X", null, 485, "[]"],
        [null, "x", "X", null, null, "[]"],
        [null, "x", "X", "d".repeat(2001), 30, "[]"],
        [null, "x", "X", null, 30, '[{"id":"q"}]'],
        [null, "meeting", "X", null, 30, "[]"],
      ];
      for (const params of bad) {
        const error = await sqlError(client, saveEventType, params);
        expect(error.code, JSON.stringify(params)).toBe("23514");
        expect(error.message).toMatch(/^[A-Z][^]*\.$/);
      }
      expect((await sqlError(client, saveEventType, [crypto.randomUUID(), "x", "X", null, 30, "[]"])).code).toBe("P0002");
    }));

  it("switch off, except the default event type", () =>
    rollback(async (client) => {
      const { admin, eventType } = await team(client);
      await actAs(client, "authenticated", admin);
      const id = await scalar<string>(client, saveEventType, [null, "intro", "Intro", null, 30, "[]"]);
      await client.query("select public.set_event_type_active($1, false)", [id]);
      expect(await scalar(client, "select active from public.event_types where id = $1", [id])).toBe(false);
      await client.query("select public.set_event_type_active($1, true)", [id]);
      expect(await scalar(client, "select active from public.event_types where id = $1", [id])).toBe(true);
      expect((await sqlError(client, "select public.set_event_type_active($1, false)", [eventType])).code).toBe("23514");
      await client.query("select public.set_event_type_active($1, true)", [eventType]);
      expect((await sqlError(client, "select public.set_event_type_active($1, true)", [crypto.randomUUID()])).code).toBe("P0002");
    }));
});

describe("booking widgets", () => {
  it("admins create and update them with hosts and normalized origins", () =>
    rollback(async (client) => {
      const { admin, host, eventType } = await team(client);
      await actAs(client, "authenticated", admin);
      const id = await scalar<string>(client, saveWidget, [
        null,
        "  Website  ",
        "person",
        [host, host],
        eventType,
        [" HTTPS://WWW.Example.com/ ", "https://www.example.com", "", "http://localhost:3000"],
      ]);
      const widget = (await client.query("select * from public.booking_widgets where id = $1", [id])).rows[0];
      expect(widget).toMatchObject({
        name: "Website",
        mode: "person",
        event_type_id: eventType,
        allowed_origins: ["http://localhost:3000", "https://www.example.com"],
        active: true,
        created_by: admin,
      });
      const hosts = async () =>
        (await client.query("select user_id from public.booking_widget_hosts where widget_id = $1 order by user_id", [id])).rows.map(
          (r) => r.user_id,
        );
      expect(await hosts()).toEqual([host]);

      expect(await scalar(client, saveWidget, [id, "Website", "round_robin", [host, admin], eventType, null])).toBe(id);
      expect(await hosts()).toEqual([host, admin].sort());
      expect(await scalar(client, "select allowed_origins from public.booking_widgets where id = $1", [id])).toEqual([]);

      await client.query("select public.set_booking_widget_active($1, false)", [id]);
      expect(await scalar(client, "select active from public.booking_widgets where id = $1", [id])).toBe(false);
    }));

  it("reject invalid input with the error codes the app maps", () =>
    rollback(async (client) => {
      const { admin, host, member, eventType } = await team(client);
      const inactive = await scalar<string>(
        client,
        "insert into public.event_types (slug, title, duration_minutes, active) values ('off', 'Off', 30, false) returning id",
      );
      await actAs(client, "authenticated", admin);
      const cases = [
        [[null, " ", "person", [host], eventType, []], "23514"],
        [[null, "W", "team", [host], eventType, []], "22023"],
        [[null, "W", null, [host], eventType, []], "22023"],
        [[null, "W", "person", [], eventType, []], "23514"],
        [[null, "W", "person", [host, admin], eventType, []], "23514"],
        [[null, "W", "round_robin", [host, member], eventType, []], "P0002"],
        [[null, "W", "person", [host], inactive, []], "P0002"],
        [[null, "W", "person", [host], null, []], "P0002"],
        [[null, "W", "person", [host], eventType, ["http://www.example.com"]], "23514"],
        [[null, "W", "person", [host], eventType, ["https://www.example.com/path"]], "23514"],
        [[crypto.randomUUID(), "W", "person", [host], eventType, []], "P0002"],
      ] as const;
      for (const [params, code] of cases) {
        expect((await sqlError(client, saveWidget, [...params])).code, JSON.stringify(params)).toBe(code);
      }
      expect((await sqlError(client, "select public.set_booking_widget_active($1, true)", [crypto.randomUUID()])).code).toBe("P0002");
    }));

  it("members read widgets and hosts but cannot write them; anon reads nothing", () =>
    rollback(async (client) => {
      const { admin, host, member, eventType } = await team(client);
      await client.query("savepoint as_admin");
      await actAs(client, "authenticated", admin);
      const id = await scalar<string>(client, saveWidget, [null, "W", "person", [host], eventType, []]);
      await client.query("reset role");

      await actAs(client, "authenticated", member);
      expect(await scalar(client, "select count(*)::int from public.booking_widgets where id = $1", [id])).toBe(1);
      expect(await scalar(client, "select count(*)::int from public.booking_widget_hosts where widget_id = $1", [id])).toBe(1);
      expect((await sqlError(client, "update public.booking_widgets set active = false")).code).toBe("42501");
      expect((await sqlError(client, "delete from public.booking_widget_hosts")).code).toBe("42501");
      expect(
        (await sqlError(client, "insert into public.booking_widget_hosts (widget_id, user_id) values ($1, $2)", [id, member])).code,
      ).toBe("42501");
      await client.query("reset role");

      await actAs(client, "anon");
      for (const table of ["event_types", "booking_widgets", "booking_widget_hosts", "booking_links"]) {
        expect((await sqlError(client, `select * from public.${table}`)).code, table).toBe("42501");
      }
      await client.query("reset role");

      // A deactivated member sees nothing.
      await client.query("update public.profiles set active = false where id = $1", [member]);
      await actAs(client, "authenticated", member);
      expect(await scalar(client, "select count(*)::int from public.booking_widgets")).toBe(0);
      expect(await scalar(client, "select count(*)::int from public.event_types")).toBe(0);
    }));

  it("table checks hold even for service_role writes", () =>
    rollback(async (client) => {
      const { eventType } = await team(client);
      await actAs(client, "service_role");
      const bad = [
        ["https://example.com/"],
        ["http://example.com"],
      ];
      for (const origins of bad) {
        const error = await sqlError(
          client,
          "insert into public.booking_widgets (name, event_type_id, allowed_origins) values ('W', $1, $2)",
          [eventType, origins],
        );
        expect(error.code).toBe("23514");
      }
    }));
});

describe("website default", () => {
  it("sets one person or round robin among bookable members", () =>
    rollback(async (client) => {
      const { admin, host, member } = await team(client);
      await actAs(client, "authenticated", admin);
      const setting = (key: string) => scalar(client, "select value from public.settings where key = $1", [key]);
      expect(await setting("website_mode")).toBe("round_robin");

      await client.query("select public.set_website_bookings('person', $1)", [host]);
      expect(await setting("website_mode")).toBe("person");
      expect(await setting("website_person_id")).toBe(host);

      await client.query("select public.set_website_bookings('round_robin', null)");
      expect(await setting("website_mode")).toBe("round_robin");

      expect((await sqlError(client, "select public.set_website_bookings('person', $1)", [member])).code).toBe("P0002");
      expect((await sqlError(client, "select public.set_website_bookings('person', null)")).code).toBe("P0002");
      expect((await sqlError(client, "select public.set_website_bookings(null, null)")).code).toBe("22023");
      expect((await sqlError(client, "select public.set_website_bookings('team', null)")).code).toBe("22023");
    }));

  it("refuses round robin when nobody is bookable", () =>
    rollback(async (client) => {
      await client.query("update public.profiles set bookable = false"); // the seed has a bookable host
      const admin = await addProfile(client, "solo@example.com", { isAdmin: true });
      await actAs(client, "authenticated", admin);
      expect((await sqlError(client, "select public.set_website_bookings('round_robin', null)")).code).toBe("P0002");
    }));
});

describe("booking links", () => {
  it("bookable members create links for themselves, admins for any bookable host", () =>
    rollback(async (client) => {
      const { admin, host, member, eventType } = await team(client);
      const inactive = await scalar<string>(
        client,
        "insert into public.event_types (slug, title, duration_minutes, active) values ('off', 'Off', 30, false) returning id",
      );
      await client.query("savepoint start");

      await actAs(client, "authenticated", host);
      await client.query(insertLink, [hash(1), host, eventType]);
      expect((await sqlError(client, insertLink, [hash(2), admin, eventType])).code).toBe("42501");
      expect((await sqlError(client, insertLink, [hash(3), host, inactive])).code).toBe("42501");
      // Members cannot mark a link used or backdate it.
      expect(
        (
          await sqlError(client, "insert into public.booking_links (token_hash, host_id, event_type_id, used_at) values ($1, $2, $3, now())", [
            hash(4),
            host,
            eventType,
          ])
        ).code,
      ).toBe("42501");
      expect((await sqlError(client, "update public.booking_links set used_at = now()")).code).toBe("42501");
      expect((await sqlError(client, "delete from public.booking_links")).code).toBe("42501");
      await client.query("reset role");

      await actAs(client, "authenticated", member);
      expect((await sqlError(client, insertLink, [hash(5), member, eventType])).code).toBe("42501");
      await client.query("reset role");

      await actAs(client, "authenticated", admin);
      await client.query(insertLink, [hash(6), host, eventType]);
      expect((await sqlError(client, insertLink, [hash(7), member, eventType])).code).toBe("42501");
      await client.query("reset role");

      await actAs(client, "anon");
      expect((await sqlError(client, insertLink, [hash(8), host, eventType])).code).toBe("42501");
    }));

  it("hosts read their own links, admins all, others none", () =>
    rollback(async (client) => {
      const { admin, host, member, eventType } = await team(client);
      await client.query(insertLink, [hash(1), host, eventType]);
      await client.query(insertLink, [hash(2), admin, eventType]);
      const visible = async (user: string) => {
        await client.query("savepoint read");
        await actAs(client, "authenticated", user);
        const count = await scalar<number>(client, "select count(*)::int from public.booking_links");
        await client.query("rollback to savepoint read");
        return count;
      };
      expect(await visible(host)).toBe(1);
      expect(await visible(admin)).toBe(2);
      expect(await visible(member)).toBe(0);
    }));

  it("checks token hash, json shapes and expiry", () =>
    rollback(async (client) => {
      const { host, eventType } = await team(client);
      await client.query(insertLink, [hash(1), host, eventType]);
      const bad = [
        [insertLink, [hash(1), host, eventType], "23505"],
        [insertLink, ["ABC", host, eventType], "23514"],
        [insertLink, [hash(1).toUpperCase().replace(/0/g, "A"), host, eventType], "23514"],
        [
          "insert into public.booking_links (token_hash, host_id, event_type_id, prefill) values ($1, $2, $3, '[]')",
          [hash(2), host, eventType],
          "23514",
        ],
        [
          "insert into public.booking_links (token_hash, host_id, event_type_id, metadata) values ($1, $2, $3, $4)",
          [hash(3), host, eventType, JSON.stringify({ blob: "x".repeat(20000) })],
          "23514",
        ],
        [
          "insert into public.booking_links (token_hash, host_id, event_type_id, expires_at) values ($1, $2, $3, now() - interval '1 minute')",
          [hash(4), host, eventType],
          "23514",
        ],
      ] as const;
      for (const [sql, params, code] of bad) {
        expect((await sqlError(client, sql, [...params])).code, sql).toBe(code);
      }
    }));
});
