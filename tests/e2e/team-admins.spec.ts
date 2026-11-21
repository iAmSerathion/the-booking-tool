import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { newHost, removeHost } from "./booking-helpers";
import { baseURL } from "./env";
import { admin, adminEmail, signInAs } from "./session";

// Team changes that touch the whole instance: the seeded admin's own right (a second admin made by a parallel test
// would let it go through) and the website default (the booking specs depend on it). They run in the "team-admins"
// Playwright project, after all other specs and one at a time, and put everything back.

test.describe.configure({ mode: "serial" });

const card = (page: Page, name: string) => page.getByRole("listitem", { name, exact: true });
const adminId = "00000000-0000-4000-8000-000000000001";
const rightsOf = async (id: string) => (await admin().from("profiles").select("is_admin, bookable").eq("id", id).single()).data!;

test("the last admin cannot remove their own admin right", async ({ page, context }) => {
  const { count } = await admin().from("profiles").select("id", { count: "exact", head: true }).eq("is_admin", true).eq("active", true);
  expect(count).toBe(1);
  await signInAs(context, baseURL, adminEmail);
  await page.goto("/app/team");
  const own = card(page, "Demo Admin");
  await expect(own.getByRole("heading")).toHaveText("Demo Admin (you)");
  await own.getByRole("button", { name: "Remove admin" }).click();
  await expect(own.getByRole("alert")).toHaveText("At least one active member must stay an admin.");
  expect((await rightsOf(adminId)).is_admin).toBe(true);
});

test("an admin switches rights and the website default; a member booked through the website stays bookable", async ({ page, context }) => {
  const host = await newHost({ name: `Rights ${randomUUID().slice(0, 8)}` });
  const { data: before } = await admin().from("settings").select("key, value").in("key", ["website_mode", "website_person_id"]);
  try {
    await signInAs(context, baseURL, adminEmail);
    await page.goto("/app/team");
    const item = card(page, host.name);
    await item.getByRole("button", { name: "Make admin" }).click();
    await expect(item.getByRole("button", { name: "Remove admin" })).toBeVisible();
    expect((await rightsOf(host.id)).is_admin).toBe(true);
    await item.getByRole("button", { name: "Remove admin" }).click();
    await expect(item.getByRole("button", { name: "Make admin" })).toBeVisible();
    expect((await rightsOf(host.id)).is_admin).toBe(false);

    const website = page.getByRole("region", { name: "Website bookings" });
    await website.getByLabel("One person").check();
    await website.getByLabel("Person", { exact: true }).selectOption({ label: host.name });
    await website.getByRole("button", { name: "Save website bookings" }).click();
    await expect(website.getByRole("status")).toHaveText("Saved.");
    const settings = async () => Object.fromEntries((await admin().from("settings").select("key, value").in("key", ["website_mode", "website_person_id"])).data!.map((r) => [r.key, r.value]));
    expect(await settings()).toEqual({ website_mode: "person", website_person_id: host.id });

    await item.getByRole("button", { name: "Make not bookable" }).click();
    await expect(item.getByRole("alert")).toHaveText("This member is still booked through a widget or the website. Change those first.");
    expect((await rightsOf(host.id)).bookable).toBe(true);

    await website.getByLabel("Round robin").check();
    await website.getByRole("button", { name: "Save website bookings" }).click();
    await expect(website.getByRole("status")).toHaveText("Saved.");
    expect((await settings()).website_mode).toBe("round_robin");
    await item.getByRole("button", { name: "Make not bookable" }).click();
    await expect(item.getByRole("button", { name: "Make bookable" })).toBeVisible();
    expect((await rightsOf(host.id)).bookable).toBe(false);
  } finally {
    await admin().from("settings").delete().in("key", ["website_mode", "website_person_id"]);
    if (before?.length) await admin().from("settings").insert(before);
    await removeHost(host.id);
  }
});
