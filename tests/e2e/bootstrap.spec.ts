import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { User } from "@supabase/supabase-js";
import { admitUser } from "@/lib/auth/admit";
import { admin } from "./session";

// Fresh-install bootstrap through admitUser: no active admin yet, so INITIAL_ADMIN_EMAIL becomes the first admin.
// It has to deactivate the seeded admins, which would break every other test; so it runs in its own Playwright
// project ("bootstrap" in playwright.config.ts) that starts only after all other specs are done, and puts everything
// back in a finally block.

test("the initial admin email becomes the first admin on a fresh install", async () => {
  const email = `first-${randomUUID()}@example.com`;
  const { data: admins, error } = await admin().from("profiles").select("id").eq("is_admin", true).eq("active", true);
  if (error) throw error;
  expect(admins?.length).toBeGreaterThan(0);
  const { data: created, error: createError } = await admin().auth.admin.createUser({ email, email_confirm: true });
  if (createError) throw createError;
  const user = {
    ...created.user,
    identities: [{ provider: "google", identity_data: { email_verified: true } }],
  } as unknown as User;

  try {
    await admin().from("profiles").update({ active: false }).in("id", admins!.map((a) => a.id));
    // Without the initial admin email nobody is admitted, even on a fresh install.
    expect(await admitUser(admin(), user, { allowedDomains: [], initialAdminEmail: null })).toBe("stranger");
    expect(await admitUser(admin(), user, { allowedDomains: [], initialAdminEmail: email })).toBe("in");
    const { data: profile } = await admin().from("profiles").select("email, is_admin, active").eq("id", user.id).single();
    expect(profile).toEqual({ email, is_admin: true, active: true });
    // Now there is an active admin again: a second initial admin is refused.
    const second = `second-${randomUUID()}@example.com`;
    const { data: other, error: otherError } = await admin().auth.admin.createUser({ email: second, email_confirm: true });
    if (otherError) throw otherError;
    try {
      const secondUser = { ...other.user, identities: [{ provider: "google", identity_data: { email_verified: true } }] } as unknown as unknown as User;
      expect(await admitUser(admin(), secondUser, { allowedDomains: [], initialAdminEmail: second })).toBe("stranger");
    } finally {
      await admin().auth.admin.deleteUser(other.user.id);
    }
  } finally {
    await admin().from("profiles").delete().eq("id", user.id);
    await admin().auth.admin.deleteUser(user.id);
    await admin().from("profiles").update({ active: true }).in("id", admins!.map((a) => a.id));
  }
});
