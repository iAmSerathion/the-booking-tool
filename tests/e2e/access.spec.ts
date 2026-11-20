import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { User } from "@supabase/supabase-js";
import { admitUser } from "@/lib/auth/admit";
import { admin, adminEmail, hostEmail } from "./session";

// admitUser is what /auth/callback runs after the Google code exchange. GoTrue's Google provider cannot be faked, so
// these tests hand it the user GoTrue would return (a real auth user plus a Google identity) against the local stack.
// The "no active admin yet" bootstrap and its race are covered in tests/db/team.test.ts (admit_profile), because the
// seeded stack always has an active admin and other tests run in parallel.

const created: string[] = [];

async function googleUser(email: string, hd?: string, verified = true): Promise<User> {
  const { data, error } = await admin().auth.admin.createUser({ email, email_confirm: true, user_metadata: { full_name: "New Person" } });
  if (error) throw error;
  created.push(data.user.id);
  return { ...data.user, identities: [{ provider: "google", identity_data: { email_verified: verified, ...(hd ? { custom_claims: { hd } } : {}) } }] } as User;
}

async function existingUser(email: string): Promise<User> {
  const { data } = await admin().from("profiles").select("id").eq("email", email).single();
  const { data: user, error } = await admin().auth.admin.getUserById(data!.id);
  if (error) throw error;
  return { ...user.user, identities: [{ provider: "google", identity_data: {} }] } as User;
}

const profileOf = async (id: string) => (await admin().from("profiles").select("name, email, is_admin, active").eq("id", id).maybeSingle()).data;
const unique = () => `new-${randomUUID()}@example.com`;
const inviteOnly = { allowedDomains: [], initialAdminEmail: null };

test.afterAll(async () => {
  for (const id of created) {
    await admin().from("profiles").delete().eq("id", id);
    await admin().auth.admin.deleteUser(id);
  }
});

test("lets existing active members in without a Workspace domain", async () => {
  expect(await admitUser(admin(), await existingUser(hostEmail), inviteOnly)).toBe("in");
});

test("refuses strangers when sign-in is invite-only", async () => {
  const user = await googleUser(unique(), "example.com");
  expect(await admitUser(admin(), user, inviteOnly)).toBe("stranger");
  expect(await profileOf(user.id)).toBeNull();
});

test("creates a member for an allowed Workspace domain", async () => {
  const email = unique();
  const user = await googleUser(email, "example.com");
  expect(await admitUser(admin(), user, { allowedDomains: ["example.com"], initialAdminEmail: null })).toBe("in");
  expect(await profileOf(user.id)).toEqual({ name: "New Person", email, is_admin: false, active: true });
  // Next sign-in: the profile exists, no second insert.
  expect(await admitUser(admin(), user, inviteOnly)).toBe("in");
});

test("refuses a consumer account with an allowed email domain but no hd claim", async () => {
  const user = await googleUser(unique());
  expect(await admitUser(admin(), user, { allowedDomains: ["example.com"], initialAdminEmail: null })).toBe("stranger");
});

test("does not create a second admin from INITIAL_ADMIN_EMAIL once an admin exists", async () => {
  const email = unique();
  const user = await googleUser(email);
  expect(await admitUser(admin(), user, { allowedDomains: [], initialAdminEmail: email })).toBe("stranger");
  expect(await profileOf(user.id)).toBeNull();
  expect((await profileOf((await existingUser(adminEmail)).id))?.is_admin).toBe(true);
});

test("keeps deactivated members out, even from an allowed domain", async () => {
  const email = unique();
  const user = await googleUser(email, "example.com");
  await admin().from("profiles").insert({ id: user.id, name: "Gone", email, active: false });
  expect(await admitUser(admin(), user, { allowedDomains: ["example.com"], initialAdminEmail: email })).toBe("out");
  expect((await profileOf(user.id))?.active).toBe(false);
});

test("refuses an unverified Google email, even from an allowed domain or as the initial admin", async () => {
  const email = unique();
  const user = await googleUser(email, "example.com", false);
  expect(await admitUser(admin(), user, { allowedDomains: ["example.com"], initialAdminEmail: email })).toBe("stranger");
  expect(await profileOf(user.id)).toBeNull();
});

test("refuses users without a Google identity", async () => {
  const user = await googleUser(unique(), "example.com");
  expect(await admitUser(admin(), { ...user, identities: [] }, { allowedDomains: ["example.com"], initialAdminEmail: null })).toBe("stranger");
});
