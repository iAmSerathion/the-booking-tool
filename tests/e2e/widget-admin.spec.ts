import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { widgetSnippets } from "@/lib/core/widget";
import { newHost, newPage, noSideScroll, removeHost } from "./booking-helpers";
import { baseURL, embedOrigin } from "./env";
import { admin, adminEmail, signInAs, userClient } from "./session";
import { discoveryCall, newWidget, removeWidget } from "./widget-helpers";

// The widget admin and the playground: an admin creates a widget for the test host origin, its snippet embeds it there,
// switching it off closes it (the closed view, frame-ancestors 'none'); members can neither open the pages nor change
// widgets. Each test has its own host and widget, found by unique names (the seeded admin sees every test's widgets).

const card = (page: Page, name: string) => page.getByRole("listitem", { name, exact: true });
const widgetByName = async (name: string) => (await admin().from("booking_widgets").select("*, booking_widget_hosts(user_id)").eq("name", name).single()).data!;
// The snippet the admin copied, served as a page of the test host origin (no request reaches the host site's server).
async function hostSite(page: Page, path: string, snippet: string) {
  // A fulfilled response has no loopback address, so Chromium's Local Network Access check would block widget.js from
  // 127.0.0.1; the real embed-site.mjs page needs no grant.
  await page.context().grantPermissions(["local-network-access"], { origin: embedOrigin });
  await page.route(`${embedOrigin}${path}`, (route) =>
    route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><head><title>Host</title></head><body><h1>Host site</h1>\n${snippet}\n</body></html>` }),
  );
  await page.goto(`${embedOrigin}${path}`);
  // Before the deferred loader ran, the button is a plain link to the widget page.
  await page.waitForFunction(() => "BookingWidget" in window);
}

test("an admin creates a widget for an allowed site, its snippets embed it there, and switching it off closes it", async ({ page, context, browser, request }) => {
  const host = await newHost({ name: `Quinn ${randomUUID().slice(0, 8)}` });
  const name = `Widget ${randomUUID().slice(0, 8)}`;
  let id: string | null = null;
  const visitor = await newPage(browser);
  try {
    await signInAs(context, baseURL, adminEmail);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/app/widgets");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Widgets");
    const form = page.getByRole("region", { name: "New widget" });
    await form.getByLabel("Name").fill(name);
    await form.getByLabel("Event type").selectOption({ label: "Discovery call" });
    await form.getByLabel("One person").check();
    await form.getByRole("checkbox", { name: host.name }).check();

    // Origins are checked like the database does, before anything is saved.
    await form.getByLabel("Allowed sites").fill("https://www.example.com/pricing");
    await form.getByRole("button", { name: "Create widget" }).click();
    await expect(form.getByRole("alert")).toHaveText('"https://www.example.com/pricing" is not an origin such as https://www.example.com (no path).');
    await form.getByLabel("Allowed sites").fill(`${embedOrigin}/\nhttps://WWW.example.com`);
    await form.getByRole("button", { name: "Create widget" }).click();
    await expect(form.getByRole("status")).toHaveText("Saved.");

    const row = await widgetByName(name);
    id = row.id as string;
    expect(row).toMatchObject({ mode: "person", event_type_id: discoveryCall, allowed_origins: [embedOrigin, "https://www.example.com"], active: true });
    expect(row.booking_widget_hosts).toEqual([{ user_id: host.id }]);

    // The snippets carry the instance's APP_URL and copy as shown.
    const item = card(page, name);
    await item.getByText("Embed code").click();
    const snippets = widgetSnippets(baseURL, id, "en");
    await expect(item.locator("figure", { hasText: "Window snippet" }).locator("code")).toHaveText(snippets.window);
    await expect(item.locator("figure", { hasText: "Section snippet" }).locator("code")).toHaveText(snippets.section);
    await item.getByRole("button", { name: "Copy window snippet" }).click();
    await expect(item.getByRole("status").filter({ hasText: "Copied." })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(snippets.window);

    // Both snippets work on the allowed site.
    await hostSite(visitor, "/window", snippets.window);
    await visitor.getByRole("link", { name: "Book a time" }).click();
    const iframe = visitor.getByRole("dialog", { name: "Book a time" }).locator("iframe");
    await expect(iframe).toHaveAttribute("data-ready", "");
    await expect(iframe.contentFrame().getByRole("heading", { level: 1 })).toHaveText("Discovery call");
    await hostSite(visitor, "/section", snippets.section);
    const section = visitor.locator(`[data-booking-section="${id}"] > iframe`);
    await expect(section).toHaveAttribute("data-ready", "");
    await expect(section.contentFrame().getByRole("heading", { level: 1 })).toHaveText("Discovery call");

    // Edit: round robin, still one person.
    await item.getByText("Edit", { exact: true }).click();
    await item.getByLabel("Round robin").check();
    await item.getByRole("button", { name: "Save widget" }).click();
    await expect(item.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    expect((await widgetByName(name)).mode).toBe("round_robin");

    // Off: the next request already gets frame-ancestors 'none', and the page opened directly shows the closed view.
    await item.getByRole("button", { name: `Switch off ${name}` }).click();
    await expect(item.getByRole("button", { name: `Switch on ${name}` })).toBeVisible();
    expect((await widgetByName(name)).active).toBe(false);
    await page.reload();
    await expect(card(page, name).getByText("Off", { exact: true })).toBeVisible();
    expect((await request.get(`/widget/${id}`)).headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect((await request.get(`/widget/${id}/section`)).headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
    await visitor.goto(`${baseURL}/widget/${id}`);
    await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Booking here is not possible right now");
  } finally {
    await visitor.close();
    if (id) await removeWidget(id);
    await removeHost(host.id);
  }
});

test("editing a widget whose event type was switched off makes the admin pick an active one", async ({ page, context }) => {
  const host = await newHost({ name: `Rowan ${randomUUID().slice(0, 8)}` });
  const suffix = randomUUID().slice(0, 8);
  // Its own switched-off event type, so the seeded one stays on for the other tests.
  const { data: type, error } = await admin()
    .from("event_types")
    .insert({ slug: `retired-${suffix}`, title: `Retired ${suffix}`, duration_minutes: 30, active: false })
    .select("id")
    .single();
  if (error) throw error;
  const id = await newWidget([host.id], { mode: "person", eventTypeId: type.id });
  try {
    const { name } = (await admin().from("booking_widgets").select("name").eq("id", id).single()).data!;
    await signInAs(context, baseURL, adminEmail);
    await page.goto("/app/widgets");
    const item = card(page, name);
    await expect(item.getByText(`Retired ${suffix}`, { exact: true })).toBeVisible();
    await item.getByText("Edit", { exact: true }).click();
    const select = item.getByLabel("Event type");
    await expect(select).toHaveValue("");
    await expect(select.getByRole("option", { name: `Retired ${suffix} (switched off)` })).toBeDisabled();

    // Saving without a choice is refused by the form, and the widget keeps its event type.
    await item.getByLabel("Allowed sites").fill("https://www.example.com");
    await item.getByRole("button", { name: "Save widget" }).click();
    expect(await select.evaluate((el: HTMLSelectElement) => el.validity.valueMissing)).toBe(true);
    await expect(item.getByRole("status").filter({ hasText: "Saved." })).toHaveCount(0);
    expect((await widgetByName(name)).event_type_id).toBe(type.id);

    await select.selectOption({ label: "Discovery call" });
    await item.getByRole("button", { name: "Save widget" }).click();
    await expect(item.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    expect(await widgetByName(name)).toMatchObject({ event_type_id: discoveryCall, allowed_origins: ["https://www.example.com"] });
  } finally {
    await removeWidget(id);
    await admin().from("event_types").delete().eq("id", type.id);
    await removeHost(host.id);
  }
});

test("the admin pages fit a phone and a desktop screen", async ({ page, context }) => {
  await signInAs(context, baseURL, adminEmail);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/app/widgets", "/app/playground"]) {
      await page.goto(path);
      await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
      await noSideScroll(page);
    }
  }
});

test("the playground mounts an active widget with the prefill from its form", async ({ page, context }) => {
  const host = await newHost({ name: `Sage ${randomUUID().slice(0, 8)}` });
  // No origins of its own: only the instance itself may frame it, which is all the playground needs.
  const id = await newWidget([host.id], { mode: "person", origins: [] });
  try {
    await signInAs(context, baseURL, adminEmail);
    await page.goto("/app/playground");
    await page.getByLabel("Widget", { exact: true }).selectOption(id);
    await page.getByLabel("Name").fill("Robin Invitee");
    await page.getByLabel("Email").fill("robin@example.com");
    await page.getByRole("button", { name: "Show section" }).click();
    const section = page.locator(`[data-booking-section="${id}"] > iframe`);
    await expect(section).toHaveAttribute("data-ready", "");
    const frame = section.contentFrame();
    await expect(frame.getByLabel("Name", { exact: true })).toHaveValue("Robin Invitee");
    await expect(frame.getByLabel("Email", { exact: true })).toHaveValue("robin@example.com");
    await expect(page.getByRole("log", { name: "Widget events" })).toBeEmpty();
  } finally {
    await removeWidget(id);
    await removeHost(host.id);
  }
});

test("members cannot open the widget admin or the playground, and the database refuses their widget changes", async ({ page, context }) => {
  const member = await newHost({ name: `Member ${randomUUID().slice(0, 8)}` });
  try {
    await signInAs(context, baseURL, member.email);
    await page.goto("/app/settings");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Settings" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Widgets" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Playground" })).toHaveCount(0);
    for (const path of ["/app/widgets", "/app/playground"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }), path).toHaveText("Page not found");
    }

    const asMember = await userClient(member.email);
    const save = await asMember.rpc("save_booking_widget", {
      p_id: null,
      p_name: "Not allowed",
      p_mode: "person",
      p_host_ids: [member.id],
      p_event_type_id: discoveryCall,
      p_allowed_origins: [embedOrigin],
    });
    expect(save.error?.code).toBe("42501");
    const seeded = "00000000-0000-4000-8000-000000000201";
    expect((await asMember.rpc("set_booking_widget_active", { p_id: seeded, p_active: false })).error?.code).toBe("42501");
    expect((await admin().from("booking_widgets").select("active").eq("id", seeded).single()).data!.active).toBe(true);
  } finally {
    await removeHost(member.id);
  }
});
