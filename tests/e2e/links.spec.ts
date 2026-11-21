import { createHash, randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { bookingsOf, newHost, newPage, nextDay, noSideScroll, openDay, removeHost, zone } from "./booking-helpers";
import { admin, adminEmail, signInAs } from "./session";

// Booking links: created in the admin, booked through "/l/<token>" with the prefill, closed after one use, on expiry and
// on revoke. Every test has its own host (and so its own links and bookings); the seeded "Discovery call" event type is
// only read. The seeded admin sees every parallel test's links, so cards are found by their unique invitee name.

test.use({ timezoneId: zone, locale: "en-US" });

type Host = Awaited<ReturnType<typeof newHost>>;
const discoveryCall = "00000000-0000-4000-8000-000000000101";
const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const card = (page: Page, name: string) => page.getByRole("listitem").filter({ hasText: name });

// Creates a link on /app/links as the signed-in member and returns its URL from the "shown once" field.
async function createLink(page: Page, name: string, email: string, { metadata = {} as Record<string, string>, singleUse = true } = {}) {
  await page.goto("/app/links");
  await page.getByLabel("Event type").selectOption({ label: "Discovery call" });
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Company").fill("Example Ltd");
  await page.getByLabel("What would you like to talk about?").selectOption("Pricing");
  if (!singleUse) await page.getByLabel("Single use: closes after one booking").uncheck();
  for (const [i, [key, value]] of Object.entries(metadata).entries()) {
    await page.getByLabel(`Metadata key ${i + 1}`).fill(key);
    await page.getByLabel(`Metadata value ${i + 1}`).fill(value);
  }
  await page.getByRole("button", { name: "Create link" }).click();
  const field = page.getByLabel("New booking link");
  await expect(field).toHaveValue(/\/l\/[\w-]{43}$/);
  return field.inputValue();
}

async function bookThroughLink(page: Page, url: string, day: string, time: string, email?: string) {
  await page.goto(url);
  await (await openDay(page, day)).getByRole("button", { name: time }).click();
  if (email) await page.getByLabel("Email", { exact: true }).fill(email);
  // The bot check wants more than three seconds between page load and submit.
  await page.waitForTimeout(3100);
  await page.getByRole("button", { name: "Book this time" }).click();
}

async function signedInHost(context: BrowserContext, baseURL: string, options: Parameters<typeof newHost>[0] = {}): Promise<Host> {
  const host = await newHost(options);
  await signInAs(context, baseURL, host.email);
  return host;
}

test("a host creates a single-use link with prefill and metadata; the invitee books through it once, then it is closed", async ({ page, context, baseURL, browser }) => {
  const host = await signedInHost(context, baseURL!, { name: "Morgan Host" });
  const invitee = await newPage(browser);
  try {
    const name = `Ada ${randomUUID().slice(0, 8)}`;
    const email = `link-${randomUUID()}@example.com`;
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const url = await createLink(page, name, email, { metadata: { campaign: "spring", "ref.id": "42" } });
    expect(url.startsWith(`${baseURL}/l/`)).toBe(true);
    await page.getByRole("button", { name: "Copy link" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Copied." })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);

    // Only the hash is stored, with the host, prefill and metadata.
    const token = url.split("/").at(-1)!;
    const { data: links } = await admin().from("booking_links").select("*").eq("host_id", host.id);
    expect(links).toEqual([
      expect.objectContaining({
        token_hash: sha256(token),
        event_type_id: discoveryCall,
        single_use: true,
        expires_at: null,
        revoked_at: null,
        prefill: { name, email, company: "Example Ltd", answers: { topic: "Pricing" } },
        metadata: { campaign: "spring", "ref.id": "42" },
      }),
    ]);
    expect(JSON.stringify(links)).not.toContain(token);
    await page.reload();
    await expect(page.getByLabel("New booking link")).toHaveCount(0);
    await expect(card(page, name)).toContainText("Active");
    await expect(card(page, name)).toContainText("campaign=spring, ref.id=42");

    // The invitee sees the host's page for the event type, prefilled and still editable; the metadata never shows.
    await invitee.goto(url);
    await expect(heading(invitee)).toHaveText("Discovery call");
    await expect(invitee.getByText("with Morgan Host")).toBeVisible();
    await expect(invitee.getByLabel("Name", { exact: true })).toHaveValue(name);
    await expect(invitee.getByLabel("Email", { exact: true })).toHaveValue(email);
    await expect(invitee.getByLabel("Company")).toHaveValue("Example Ltd");
    await expect(invitee.getByRole("radio", { name: "Pricing" })).toBeChecked();
    expect(await invitee.content()).not.toContain("spring");
    const day = nextDay([1, 2, 3, 4, 5]);
    await bookThroughLink(invitee, url, day, "10:00 AM");
    await expect(heading(invitee)).toHaveText("Your booking is confirmed.");

    const [booking] = await bookingsOf(host.id);
    const { data: row } = await admin().from("bookings").select("booked_via, link_id, invitee_company, answers").eq("id", booking.id).single();
    expect(row).toMatchObject({ booked_via: "link", link_id: links![0].id, invitee_company: "Example Ltd", answers: [{ id: "topic", answer: "Pricing" }] });
    const { data: outbox } = await admin().from("booking_outbox").select("type, payload").eq("booking_id", booking.id);
    expect(outbox).toEqual([{ type: "booking.created", payload: expect.objectContaining({ link: { id: links![0].id, metadata: { campaign: "spring", "ref.id": "42" } } }) }]);

    // The second visit gets the neutral closed view, the same as an unknown token.
    await invitee.goto(url);
    await expect(heading(invitee)).toHaveText("This link can no longer be used");
    await expect(invitee.getByRole("button", { name: "Book this time" })).toHaveCount(0);
    await invitee.goto(`/l/${"A".repeat(43)}`);
    await expect(heading(invitee)).toHaveText("This link can no longer be used");

    await page.reload();
    await expect(card(page, name)).toContainText("Used");
    await expect(card(page, name).getByRole("button", { name: "Revoke" })).toHaveCount(0);
  } finally {
    await invitee.context().close();
    await removeHost(host.id);
  }
});

test("a single-use link opened in two tabs books once; the second submit is rejected", async ({ page, context, baseURL, browser }) => {
  const host = await signedInHost(context, baseURL!);
  const first = await newPage(browser);
  const second = await newPage(browser);
  try {
    const name = `Grace ${randomUUID().slice(0, 8)}`;
    const url = await createLink(page, name, `race-${randomUUID()}@example.com`);
    const day = nextDay([1, 2, 3, 4, 5]);
    // Both tabs load the open link before either books.
    await second.goto(url);
    await bookThroughLink(first, url, day, "9:00 AM");
    await expect(heading(first)).toHaveText("Your booking is confirmed.");

    await (await openDay(second, day)).getByRole("button", { name: "2:00 PM" }).click();
    await second.getByLabel("Email", { exact: true }).fill(`other-${randomUUID()}@example.com`);
    await second.waitForTimeout(3100);
    await second.getByRole("button", { name: "Book this time" }).click();
    await expect(second.getByRole("main").getByRole("alert")).toHaveText("This booking link can no longer be used.");
    expect(await bookingsOf(host.id)).toHaveLength(1);
  } finally {
    await first.context().close();
    await second.context().close();
    await removeHost(host.id);
  }
});

test("expired and revoked links show the closed view; the admin sees and revokes any host's link", async ({ page, context, baseURL, browser }) => {
  const host = await signedInHost(context, baseURL!, { name: "Quinn Host" });
  const invitee = await newPage(browser);
  const adminContext = await browser.newContext({ timezoneId: zone, locale: "en-US" });
  try {
    // Expired: created two days ago, expired yesterday (straight into the table; the form only takes future expiry).
    const expired = randomUUID().replace(/-/g, "") + "abcdefghijk";
    const { error } = await admin()
      .from("booking_links")
      .insert({
        token_hash: sha256(expired),
        host_id: host.id,
        event_type_id: discoveryCall,
        created_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        expires_at: new Date(Date.now() - 86_400_000).toISOString(),
      });
    if (error) throw error;
    await invitee.goto(`/l/${expired}`);
    await expect(heading(invitee)).toHaveText("This link can no longer be used");

    // A reusable link with an expiry in the future works until the host revokes it.
    const name = `Linus ${randomUUID().slice(0, 8)}`;
    const reusable = await createLink(page, name, `revoke-${randomUUID()}@example.com`, { singleUse: false });
    await page.goto("/app/links");
    await expect(card(page, name)).toContainText("Reusable");
    await invitee.goto(reusable);
    await expect(heading(invitee)).toHaveText("Discovery call");
    await card(page, name).getByRole("button", { name: "Revoke" }).click();
    await expect(card(page, name)).toContainText("Revoked");
    await invitee.goto(reusable);
    await expect(heading(invitee)).toHaveText("This link can no longer be used");

    // The seeded admin sees the host's links with the host's name and can revoke them.
    const other = `Mira ${randomUUID().slice(0, 8)}`;
    const otherUrl = await createLink(page, other, `admin-${randomUUID()}@example.com`);
    await signInAs(adminContext, baseURL!, adminEmail);
    const adminPage = await adminContext.newPage();
    await adminPage.goto("/app/links");
    await expect(adminPage.getByRole("heading", { name: "All links" })).toBeVisible();
    await expect(card(adminPage, other)).toContainText("Quinn Host");
    await card(adminPage, other).getByRole("button", { name: "Revoke" }).click();
    await expect(card(adminPage, other)).toContainText("Revoked");
    await invitee.goto(otherUrl);
    await expect(heading(invitee)).toHaveText("This link can no longer be used");
    const { data } = await admin().from("booking_links").select("expires_at, revoked_at").eq("host_id", host.id);
    expect(data!.filter((l) => l.revoked_at)).toHaveLength(2);
  } finally {
    await adminContext.close();
    await invitee.context().close();
    await removeHost(host.id);
  }
});

test("the links page and a link's booking page fit 390px and 1440px without sideways scrolling", async ({ page, context, baseURL }) => {
  const host = await signedInHost(context, baseURL!);
  try {
    const url = await createLink(page, `Ivy ${randomUUID().slice(0, 8)}`, `fit-${randomUUID()}@example.com`, { metadata: { key: "value" } });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/app/links");
      await expect(page.getByLabel("Metadata key 1")).toBeVisible();
      await noSideScroll(page);
      await page.goto(url);
      await expect(page.getByLabel("Name", { exact: true })).not.toHaveValue("");
      await noSideScroll(page);
    }
  } finally {
    await removeHost(host.id);
  }
});

test("without JavaScript (before hydration) the link and booking submit buttons and the calendar stay disabled, so nothing submits as a GET or gets lost", async ({ browser, baseURL }) => {
  const host = await newHost({ name: "Quinn Host" });
  const context = await browser.newContext({ javaScriptEnabled: false, timezoneId: zone, locale: "en-US" });
  try {
    await signInAs(context, baseURL!, host.email);
    const page = await context.newPage();
    await page.goto("/app/links");
    await expect(page.getByRole("button", { name: "Create link" })).toBeDisabled();
    await page.goto(`/${host.slug}`);
    await expect(page.getByRole("button", { name: "Book this time" })).toBeDisabled();
    // The calendar too: a day clicked before hydration would be lost.
    const days = page.getByRole("group", { name: "Days with free times" }).getByRole("button");
    await expect(days.first()).toBeVisible();
    await expect(days.and(page.locator(":enabled"))).toHaveCount(0);
  } finally {
    await context.close();
    await removeHost(host.id);
  }
});
