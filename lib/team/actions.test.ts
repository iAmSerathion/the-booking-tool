import { beforeEach, describe, expect, it, vi } from "vitest";

// The team actions with the member, the config and the database stubbed: the admin guard comes before any database
// call, input is checked before the RPC, the actor of an invite is the signed-in member, and errors map to admin text.
// The RPCs themselves (assert_is_admin, the at-least-one-admin rule) are tested against Postgres in tests/db/team.test.ts.

type DbError = { code: string; message: string } | null;
const state = vi.hoisted(() => ({
  isAdmin: true,
  error: null as DbError,
  createError: null as DbError,
  existing: null as { id: string } | null,
  calls: [] as unknown[][],
}));

vi.mock("next/cache", () => ({ refresh: () => state.calls.push(["refresh"]) }));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ appUrl: "https://booking.example.com", google: { hostedDomain: null } }) }));
const rpc = async (name: string, args: unknown) => (state.calls.push([name, args]), { data: null, error: state.error });
vi.mock("@/lib/auth/member", () => ({ signedIn: async () => ({ isAdmin: state.isAdmin, userId: "actor", supabase: { rpc } }) }));
vi.mock("@/lib/db/admin", () => ({
  createAdminSupabase: () => ({
    rpc,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.existing }) }) }) }),
    auth: {
      admin: {
        createUser: async (args: unknown) => (state.calls.push(["createUser", args]), state.createError ? { data: { user: null }, error: state.createError } : { data: { user: { id: "new-user" } }, error: null }),
        deleteUser: async (id: string) => state.calls.push(["deleteUser", id]),
      },
    },
  }),
}));

vi.mock("./deactivate", () => ({
  deactivate: async (args: unknown) => (state.calls.push(["deactivate", args]), { ok: true, message: "Ada is deactivated." }),
}));

const { deactivateMember, inviteMember, reactivateMember, setMemberRight, setMemberSlug, setWebsiteBookings } = await import("./actions");

const id = "00000000-0000-4000-8000-000000000011";
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return data;
};
const empty = { error: null, saved: false };
const ok = { error: null, saved: true };
const invite = { name: "Ada Lovelace", email: "Ada@Example.com", slug: "", bookable: "on" };

beforeEach(() => {
  Object.assign(state, { isAdmin: true, error: null, createError: null, existing: null, calls: [] });
});

describe("team actions", () => {
  it("refuses members before touching the database", async () => {
    state.isAdmin = false;
    const refused = { error: "Only admins can change the team.", saved: false };
    expect(await setMemberRight(empty, form({ profile_id: id, right: "is_admin", on: "true" }))).toEqual(refused);
    expect(await setMemberSlug(empty, form({ profile_id: id, slug: "ada" }))).toEqual(refused);
    expect(await inviteMember(empty, form(invite))).toEqual(refused);
    expect(await reactivateMember(empty, form({ profile_id: id }))).toEqual(refused);
    expect(await deactivateMember(empty, form({ profile_id: id, to_id: id }))).toEqual(refused);
    expect(await setWebsiteBookings(empty, form({ mode: "round_robin" }))).toEqual(refused);
    expect(state.calls).toEqual([]);
  });

  it("sets one right and shows the database's refusal, such as the last admin rule", async () => {
    expect(await setMemberRight(empty, form({ profile_id: id, right: "bookable", on: "false" }))).toEqual(ok);
    expect(state.calls).toEqual([["set_person_rights", { p_person_id: id, p_rights: { bookable: false } }], ["refresh"]]);
    expect(await setMemberRight(empty, form({ profile_id: id, right: "can_everything", on: "true" }))).toEqual({ error: "Unknown right.", saved: false });
    state.error = { code: "P0002", message: "At least one active member must stay an admin." };
    expect(await setMemberRight(empty, form({ profile_id: id, right: "is_admin", on: "false" }))).toEqual({ error: "At least one active member must stay an admin.", saved: false });
  });

  it("checks a slug first and words the constraint errors itself", async () => {
    expect(await setMemberSlug(empty, form({ profile_id: id, slug: " Ada-L " }))).toEqual(ok);
    expect(state.calls[0]).toEqual(["set_slug", { p_profile_id: id, p_slug: "ada-l" }]);
    state.calls = [];
    expect(await setMemberSlug(empty, form({ profile_id: id, slug: "login" }))).toMatchObject({ error: '"login" is reserved for the app. Choose another link name.' });
    expect(await setMemberSlug(empty, form({ profile_id: "1", slug: "ada" }))).toMatchObject({ error: "This member does not exist." });
    expect(state.calls).toEqual([]);
    state.error = { code: "23505", message: 'duplicate key value violates unique constraint "profiles_slug_key"' };
    expect(await setMemberSlug(empty, form({ profile_id: id, slug: "ada" }))).toMatchObject({ error: "This link name is taken." });
    state.error = { code: "23514", message: 'new row violates check constraint "profiles_slug_check"' };
    expect(await setMemberSlug(empty, form({ profile_id: id, slug: "ada" }))).toMatchObject({ error: "This link name is not allowed." });
  });

  it("invites with the session's actor and tells the admin how the person signs in", async () => {
    expect(await inviteMember(empty, form({ ...invite, profile_id: "someone-else", p_actor_id: id }))).toEqual({
      ...ok,
      message: "Invited. Ada Lovelace signs in at https://booking.example.com/login with Google (ada@example.com).",
    });
    expect(state.calls).toEqual([
      ["createUser", { email: "ada@example.com", email_confirm: true }],
      ["invite_profile", { p_id: "new-user", p_actor_id: "actor", p_profile: { name: "Ada Lovelace", email: "ada@example.com", slug: "ada-lovelace", is_admin: false, bookable: true } }],
      ["refresh"],
    ]);
  });

  it("deletes the new auth user when the profile fails, and never an existing one", async () => {
    state.error = { code: "23505", message: "duplicate" };
    expect(await inviteMember(empty, form(invite))).toEqual({ error: "This email or link name is taken.", saved: false });
    expect(state.calls.at(-1)).toEqual(["deleteUser", "new-user"]);

    state.calls = [];
    state.createError = { code: "email_exists", message: "exists" };
    state.existing = { id };
    expect(await inviteMember(empty, form(invite))).toEqual({ error: "Already in the team.", saved: false });
    state.existing = null;
    expect(await inviteMember(empty, form(invite))).toEqual({ error: "This email already has an account without a team profile.", saved: false });
    expect(state.calls.map(([name]) => name)).toEqual(["createUser", "createUser"]);
  });

  it("sets the website default and reactivates", async () => {
    expect(await setWebsiteBookings(empty, form({ mode: "person", person_id: id }))).toEqual(ok);
    expect(await setWebsiteBookings(empty, form({ mode: "round_robin", person_id: id }))).toEqual(ok);
    expect(await setWebsiteBookings(empty, form({ mode: "person" }))).toEqual({ error: "Choose a person.", saved: false });
    expect(await reactivateMember(empty, form({ profile_id: id }))).toEqual(ok);
    expect(state.calls.filter(([name]) => name !== "refresh")).toEqual([
      ["set_website_bookings", { p_mode: "person", p_person_id: id }],
      ["set_website_bookings", { p_mode: "round_robin", p_person_id: null }],
      ["reactivate_profile", { p_person_id: id }],
    ]);
  });

  it("deactivates with the signed-in admin as actor, never a form field", async () => {
    const to = "00000000-0000-4000-8000-000000000022";
    expect(await deactivateMember(empty, form({ profile_id: id, to_id: to, actor_id: to }))).toEqual({ ...ok, message: "Ada is deactivated." });
    expect(state.calls).toEqual([["deactivate", { actorId: "actor", personId: id, toId: to }], ["refresh"]]);
    expect(await deactivateMember(empty, form({ profile_id: id, to_id: "x" }))).toEqual({ error: "Choose who takes over.", saved: false });
  });
});
