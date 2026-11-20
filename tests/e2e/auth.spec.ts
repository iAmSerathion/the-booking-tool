import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { admin, hostEmail, signInAs } from "./session";

// The browser side of sign-in. Google itself is never reached (GoTrue only talks to accounts.google.com), so logged-in
// tests use magic-link sessions; the access rule behind /auth/callback is covered in access.spec.ts.

async function strangerEmail(profile?: { active: boolean }) {
  const email = `stranger-${randomUUID()}@example.com`;
  const { data, error } = await admin().auth.admin.createUser({ email, email_confirm: true });
  if (error) throw error;
  if (profile) {
    const { error: insertError } = await admin().from("profiles").insert({ id: data.user.id, name: "Stranger", email, active: profile.active });
    if (insertError) throw insertError;
  }
  return { email, id: data.user.id };
}

async function remove(id: string) {
  await admin().from("profiles").delete().eq("id", id);
  await admin().auth.admin.deleteUser(id);
}

test("signed-out visitors are sent from /app to /login", async ({ page }) => {
  await page.goto("/app/settings");
  await expect(page).toHaveURL("/login");
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});

test("a member reaches the shell through /app", async ({ page, context, baseURL }) => {
  await signInAs(context, baseURL!, hostEmail);
  const response = await page.goto("/app");
  await expect(page).toHaveURL("/app/settings");
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(page.getByText(`Signed in as ${hostEmail}`)).toBeVisible();
  await expect(page.getByText("Demo Host · Member")).toBeVisible();
  expect(response!.headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
});

for (const [name, profile] of [
  ["without a profile", undefined],
  ["with a deactivated profile", { active: false }],
] as const) {
  test(`a session ${name} is signed out with a notice`, async ({ page, context, baseURL }) => {
    const user = await strangerEmail(profile);
    try {
      await signInAs(context, baseURL!, user.email);
      await page.goto("/app");
      await expect(page).toHaveURL("/login?error=no-access");
      await expect(page.getByRole("main").getByRole("alert")).toHaveText("This Google account has no access. Ask an admin to invite you.");
      // The session is gone: the next visit lands on the plain login page.
      await page.goto("/app");
      await expect(page).toHaveURL("/login");
      await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    } finally {
      await remove(user.id);
    }
  });
}

test("sign-out ends the session", async ({ page, context, baseURL }) => {
  await signInAs(context, baseURL!, hostEmail);
  await page.goto("/app/settings");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/login");
  await page.goto("/app/settings");
  await expect(page).toHaveURL("/login");
});

test("the Google button starts Supabase's Google sign-in with the APP_URL callback", async ({ page, baseURL }) => {
  // Playwright does not route redirect targets, so stop at GoTrue's redirect and never contact Google.
  let start: URL | undefined;
  let google: URL | undefined;
  await page.route("**/auth/v1/authorize?**", async (route) => {
    start = new URL(route.request().url());
    const response = await route.fetch({ maxRedirects: 0 });
    google = new URL(response.headers()["location"]);
    await route.fulfill({ body: "Google stand-in" });
  });
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await expect(page.getByText("Google stand-in")).toBeVisible();
  expect(start?.searchParams.get("provider")).toBe("google");
  expect(start?.searchParams.get("redirect_to")).toBe(`${baseURL}/auth/callback`);
  expect(start?.searchParams.get("code_challenge")).toBeTruthy();
  expect(google?.hostname).toBe("accounts.google.com");
  expect(google?.searchParams.get("prompt")).toBe("select_account");
  expect(google?.searchParams.get("redirect_uri")).toMatch(/\/auth\/v1\/callback$/);
});

test("the callback refuses a missing or unknown code", async ({ page }) => {
  for (const path of ["/auth/callback", "/auth/callback?code=not-a-real-code"]) {
    await page.goto(path);
    await expect(page).toHaveURL("/login?error=failed");
    await expect(page.getByRole("main").getByRole("alert")).toHaveText("Sign-in did not work. Please try again.");
  }
});

test("the login page shows only known notices", async ({ page }) => {
  await page.goto("/login?error=%3Cb%3Ehello%3C%2Fb%3E");
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});
