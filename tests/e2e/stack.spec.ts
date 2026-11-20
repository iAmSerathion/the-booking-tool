import { expect, test } from "@playwright/test";
import { adminEmail, anon, hostEmail, sessionCookies, signInAs, userClient } from "./session";

// Checks the test wiring itself: local Supabase, magic-link sessions and RLS through the gateway.
test("a magic-link session for a seeded member reads profiles under RLS", async () => {
  const client = await userClient(hostEmail);
  const { data: user } = await client.auth.getUser();
  expect(user.user?.email).toBe(hostEmail);
  const { data, error } = await client.from("profiles").select("email").order("email");
  expect(error).toBeNull();
  expect(data?.map((row) => row.email)).toEqual([adminEmail, hostEmail]);
});

test("signed-out visitors cannot read profiles", async () => {
  const { error } = await anon().from("profiles").select("email");
  expect(error?.code).toBe("42501");
});

test("signInAs puts the Supabase auth cookies into the browser", async ({ context, baseURL }) => {
  const names = [...(await sessionCookies(adminEmail)).keys()];
  await signInAs(context, baseURL!, adminEmail);
  const cookies = await context.cookies(baseURL!);
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) expect(cookies.map((c) => c.name)).toContain(name);
});
