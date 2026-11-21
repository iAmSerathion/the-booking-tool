import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { newHost, noSideScroll, removeHost } from "./booking-helpers";
import { baseURL } from "./env";
import { admin, adminEmail, signInAs, userClient } from "./session";

// The team page: members see the team read-only, admins invite, change link names and reactivate. Every test works on
// its own throwaway members; changes to the seeded admin and the website default are in team-admins.spec.ts, which
// runs after all other specs.

const card = (page: Page, name: string) => page.getByRole("listitem", { name, exact: true });
const profileByEmail = async (email: string) => (await admin().from("profiles").select("id, name, slug, is_admin, bookable, active").eq("email", email).maybeSingle()).data;

test("members see the team and booking links but no controls, and the database refuses their team changes", async ({ page, context }) => {
  const member = await newHost({ name: `Member ${randomUUID().slice(0, 8)}` });
  try {
    await signInAs(context, baseURL, member.email);
    await page.goto("/app");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Team" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Team");
    const own = card(page, member.name);
    await expect(own.getByRole("link", { name: `${baseURL}/${member.slug}` })).toBeVisible();
    await expect(card(page, "Demo Admin").getByText("Admin", { exact: true })).toBeVisible();
    await expect(page.getByRole("button")).toHaveText(["Sign out"]);
    await expect(page.getByRole("region", { name: "Invite a member" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Website bookings" })).toHaveCount(0);

    const asMember = await userClient(member.email);
    for (const [fn, args] of [
      ["set_person_rights", { p_person_id: member.id, p_rights: { is_admin: true } }],
      ["set_slug", { p_profile_id: member.id, p_slug: `taken-${randomUUID().slice(0, 8)}` }],
      ["reactivate_profile", { p_person_id: member.id }],
      ["set_website_bookings", { p_mode: "person", p_person_id: member.id }],
    ] as const) {
      expect((await asMember.rpc(fn, args)).error?.code, fn).toBe("42501");
    }
    expect((await asMember.rpc("invite_profile", { p_id: member.id, p_actor_id: member.id, p_profile: {} })).error?.code).toBe("42501");
    expect(await profileByEmail(member.email)).toMatchObject({ is_admin: false, slug: member.slug });
  } finally {
    await removeHost(member.id);
  }
});

test("an admin invites a member who can then sign in; duplicates and reserved link names are refused", async ({ page, context, browser }) => {
  const suffix = randomUUID().slice(0, 8);
  const email = `invite-${suffix}@example.com`;
  const name = `Invitee ${suffix}`;
  try {
    await signInAs(context, baseURL, adminEmail);
    await page.goto("/app/team");
    const form = page.getByRole("region", { name: "Invite a member" });
    await form.getByLabel("Name", { exact: true }).fill(name);
    await form.getByLabel("Google account email").fill(email.toUpperCase());
    await form.getByLabel("Link name").fill("login");
    await form.getByRole("button", { name: "Invite" }).click();
    await expect(form.getByRole("alert")).toHaveText('"login" is reserved for the app. Choose another link name.');
    expect(await profileByEmail(email)).toBeNull();

    // An empty link name is made from the name.
    await form.getByLabel("Link name").fill("");
    await form.getByRole("button", { name: "Invite" }).click();
    await expect(form.getByRole("status")).toHaveText(`Invited. ${name} signs in at ${baseURL}/login with Google (${email}).`);
    expect(await profileByEmail(email)).toMatchObject({ name, slug: `invitee-${suffix}`, is_admin: false, bookable: false, active: true });
    await expect(card(page, name)).toBeVisible();

    // The form starts empty again after an invite; the same email a second time is refused.
    await expect(form.getByLabel("Google account email")).toHaveValue("");
    await form.getByLabel("Name", { exact: true }).fill(name);
    await form.getByLabel("Google account email").fill(email);
    await form.getByRole("button", { name: "Invite" }).click();
    await expect(form.getByRole("alert")).toHaveText("Already in the team.");

    // The invitee's account exists, so their sign-in (here a test session in place of Google) gets into the app.
    const invitee = await browser.newContext();
    try {
      await signInAs(invitee, baseURL, email);
      const own = await invitee.newPage();
      await own.goto("/app/team");
      await expect(own.getByRole("heading", { level: 1 })).toHaveText("Team");
      await expect(own.getByText(`${name} · Member`)).toBeVisible();
    } finally {
      await invitee.close();
    }
  } finally {
    const profile = await profileByEmail(email);
    if (profile) {
      // profiles.id references auth.users with on delete restrict: the profile goes first.
      await admin().from("profiles").delete().eq("id", profile.id);
      await admin().auth.admin.deleteUser(profile.id);
    }
  }
});

test("an admin changes a link name: the new page works, the old one is gone, reserved and taken names are refused", async ({ page, context, browser }) => {
  const host = await newHost({ name: `Slug ${randomUUID().slice(0, 8)}` });
  const slug = `moved-${randomUUID().slice(0, 8)}`;
  try {
    await signInAs(context, baseURL, adminEmail);
    await page.goto("/app/team");
    const item = card(page, host.name);
    await item.getByText("Change link name").click();
    const input = item.getByLabel("Link name");
    await expect(input).toHaveValue(host.slug);

    for (const [value, message] of [
      ["login", '"login" is reserved for the app. Choose another link name.'],
      ["Not Valid", "A link name uses only lowercase letters, digits and dashes."],
      ["demo-host", "This link name is taken."],
    ]) {
      await input.fill(value);
      await item.getByRole("button", { name: "Save link name" }).click();
      await expect(item.getByRole("alert")).toHaveText(message);
    }
    expect((await profileByEmail(host.email))?.slug).toBe(host.slug);

    await input.fill(slug);
    await item.getByRole("button", { name: "Save link name" }).click();
    await expect(item.getByRole("link", { name: `${baseURL}/${slug}` })).toBeVisible();
    expect((await profileByEmail(host.email))?.slug).toBe(slug);

    const visitor = await browser.newPage();
    try {
      await visitor.goto(`/${slug}`);
      await expect(visitor.getByRole("button", { name: "Next month" })).toBeVisible();
      // The status stays 200 once the page streams (as for other unknown member pages); the 404 page is what counts.
      await visitor.goto(`/${host.slug}`);
      await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Page not found");
    } finally {
      await visitor.close();
    }
  } finally {
    await removeHost(host.id);
  }
});

test("an admin reactivates a deactivated member", async ({ page, context }) => {
  const host = await newHost({ name: `Away ${randomUUID().slice(0, 8)}` });
  try {
    await admin().from("profiles").update({ active: false }).eq("id", host.id);
    await signInAs(context, baseURL, adminEmail);
    await page.goto("/app/team");
    const item = card(page, host.name);
    await expect(item.getByText("Deactivated")).toBeVisible();
    await item.getByRole("button", { name: "Reactivate" }).click();
    await expect(item.getByRole("button", { name: "Make admin" })).toBeVisible();
    expect((await profileByEmail(host.email))?.active).toBe(true);
  } finally {
    await removeHost(host.id);
  }
});

test("the team page fits a phone and a desktop screen", async ({ page, context }) => {
  await signInAs(context, baseURL, adminEmail);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/app/team");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Team");
    await noSideScroll(page);
  }
});
