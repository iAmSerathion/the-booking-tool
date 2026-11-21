import { randomUUID } from "node:crypto";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { dayLabel, newHost, nextDay, noSideScroll, removeHost, zone } from "./booking-helpers";
import { baseURL, embedBlockedOrigin, embedOrigin } from "./env";
import { admin } from "./session";
import { discoveryCall, newWidget, removeWidget } from "./widget-helpers";

// The widget embedded in a host website (tests/e2e/embed-site.mjs) through public/widget.js: window and section on an
// allowed origin, with prefill and a booking, and the same page on an origin the widget does not allow, where
// frame-ancestors blocks the frame. Every test creates its own host and widget.

test.use({ timezoneId: zone, locale: "en-US" });

const hostPage = (origin: string, id: string) => `${origin}/pricing/?id=${id}`;
const events = (page: Page) => page.evaluate(() => (window as unknown as { widgetEvents: { type: string; detail: unknown }[] }).widgetEvents);
const mountSection = (page: Page, prefill: unknown) =>
  page.evaluate((p) => {
    const api = (window as unknown as { BookingWidget: { mount(el: Element, p: unknown): unknown } }).BookingWidget;
    return api.mount(document.querySelector("[data-booking-section]")!, p) !== null;
  }, prefill);
const sectionFrame = (page: Page) => page.locator("[data-booking-section] > iframe");

// Picks the day and time inside the frame. The bot check wants more than three seconds between load and submit.
async function pickTime(page: Page, frame: FrameLocator, day: string, time: string) {
  const button = frame.getByRole("button", { name: dayLabel(day), exact: true });
  for (let i = 0; i < 3 && !(await button.isVisible()); i++) await frame.getByRole("button", { name: "Next month" }).click();
  await button.click();
  await frame.getByRole("group", { name: `Free times on ${dayLabel(day)}` }).getByRole("button", { name: time }).click();
  await page.waitForTimeout(3100);
}

const bookingRow = async (hostId: string) =>
  (await admin().from("bookings").select("booked_via, widget_id, event_type_id, booking_page, invitee_name, invitee_email, invitee_company, topic, answers").eq("host_id", hostId)).data!;

test("the window opens on an allowed origin, books through the widget and records the host page", async ({ page }) => {
  const host = await newHost({ name: "Wren Host" });
  const id = await newWidget([host.id], { mode: "person" });
  try {
    await page.goto(hostPage(embedOrigin, id));
    await page.getByRole("link", { name: "Book a time" }).click();
    const dialog = page.getByRole("dialog", { name: "Book a time" });
    await expect(dialog).toBeVisible();
    const iframe = dialog.locator("iframe");
    await expect(iframe).toHaveAttribute("data-ready", "");
    await expect(iframe).toHaveAttribute("src", `${baseURL}/widget/${id}?page=%2Fpricing`);
    const frame = iframe.contentFrame();
    await expect(frame.getByRole("heading", { level: 1 })).toHaveText("Discovery call");

    // Escape inside the frame closes the window, and focus returns to the button.
    await frame.getByRole("heading", { level: 1 }).click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("link", { name: "Book a time" })).toBeFocused();

    await page.getByRole("link", { name: "Book a time" }).click();
    await pickTime(page, frame, nextDay([1, 2, 3, 4, 5]), "9:00 AM");
    await frame.getByRole("radio", { name: "Pricing" }).check();
    await frame.getByLabel("Name", { exact: true }).fill("Robin Invitee");
    await frame.getByLabel("Email", { exact: true }).fill(`invitee-${randomUUID()}@example.com`);
    await frame.getByRole("button", { name: "Book this time" }).click();
    await expect(frame.getByRole("heading", { level: 1 })).toHaveText("Your booking is confirmed.");

    const [row, ...more] = await bookingRow(host.id);
    expect(more).toEqual([]);
    expect(row).toMatchObject({ booked_via: "widget", widget_id: id, event_type_id: discoveryCall, booking_page: `${embedOrigin}/pricing` });

    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    // The window never reports "booked"; only sections do.
    expect(await events(page)).toEqual([]);
  } finally {
    await removeWidget(id);
    await removeHost(host.id);
  }
});

test("a section on an allowed origin takes the prefill, custom answers included, books and tells the host page once", async ({ page }) => {
  const host = await newHost({ name: "Ellis Host" });
  const id = await newWidget([host.id], { mode: "person" });
  const email = `invitee-${randomUUID()}@example.com`;
  try {
    await page.goto(hostPage(embedOrigin, id));
    expect(await mountSection(page, { name: "Ada Example", email, company: "Example Ltd", topic: "Moving our team\nto one calendar", answers: [{ id: "topic", answer: "Pricing" }] })).toBe(true);
    const iframe = sectionFrame(page);
    await expect(iframe).toHaveAttribute("data-ready", "");
    await expect(iframe).toHaveAttribute("src", `${baseURL}/widget/${id}/section?page=%2Fpricing`);
    const frame = iframe.contentFrame();
    await expect(frame.getByLabel("Name", { exact: true })).toHaveValue("Ada Example");
    await expect(frame.getByLabel("Email", { exact: true })).toHaveValue(email);
    await expect(frame.getByLabel("Company")).toHaveValue("Example Ltd");
    await expect(frame.getByRole("radio", { name: "Pricing" })).toBeChecked();
    await expect(frame.getByRole("banner")).toHaveCount(0);

    // A changed field keeps the invitee's value when the host page updates its prefill.
    await frame.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
    expect(await mountSection(page, { name: "Someone Else", email, company: "Other Ltd", answers: [{ id: "topic", answer: "Pricing" }] })).toBe(true);
    await expect(frame.getByLabel("Company")).toHaveValue("Other Ltd");
    await expect(frame.getByLabel("Name", { exact: true })).toHaveValue("Ada Lovelace");

    await pickTime(page, frame, nextDay([1, 2, 3, 4, 5]), "11:00 AM");
    await frame.getByRole("button", { name: "Book this time" }).click();
    await expect(frame.getByRole("heading", { level: 1 })).toHaveText("Your booking is confirmed.");
    await expect.poll(() => events(page)).toEqual([{ type: "booking-widget:booked", detail: null }]);

    const [row] = await bookingRow(host.id);
    expect(row).toMatchObject({
      booked_via: "widget",
      widget_id: id,
      booking_page: `${embedOrigin}/pricing`,
      invitee_name: "Ada Lovelace",
      invitee_email: email,
      invitee_company: "Other Ltd",
      topic: "Moving our team\nto one calendar",
      answers: [{ id: "topic", question: "What would you like to talk about?", answer: "Pricing" }],
    });
  } finally {
    await removeWidget(id);
    await removeHost(host.id);
  }
});

test("on an origin the widget does not allow, frame-ancestors blocks window and section and no prefill reaches the tool", async ({ page }) => {
  test.setTimeout(60_000);
  const host = await newHost();
  const id = await newWidget([host.id], { mode: "person" });
  const email = `invitee-${randomUUID()}@example.com`;
  const toTool: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(baseURL)) toTool.push(`${request.url()} ${request.postData() ?? ""}`);
  });
  try {
    const response = await page.request.get(`/widget/${id}`);
    expect(response.headers()["content-security-policy"]).toBe(`frame-ancestors ${embedOrigin} ${baseURL}`);

    await page.goto(hostPage(embedBlockedOrigin, id));
    await page.getByRole("link", { name: "Book a time" }).click();
    const dialog = page.getByRole("dialog", { name: "Book a time" });
    await expect(dialog).toBeVisible();
    await expect.poll(() => page.frames().some((f) => f.url() === "chrome-error://chromewebdata/")).toBe(true);
    await expect(dialog.locator("iframe")).not.toHaveAttribute("data-ready");
    // The X still closes the blocked window.
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();

    expect(await mountSection(page, { name: "Ada Example", email, company: "Example Ltd" })).toBe(true);
    await expect(sectionFrame(page)).toHaveAttribute("src", `${baseURL}/widget/${id}/section?page=%2Fpricing`);
    // No "ready" ever comes from a blocked frame, so the prefill is never sent; after the timeout the section gives up.
    await expect.poll(() => events(page), { timeout: 20_000 }).toEqual([{ type: "booking-widget:unavailable", detail: null }]);
    await expect(sectionFrame(page)).toHaveCount(0);
    expect(toTool.filter((line) => line.includes(email) || line.includes("Ada") || line.includes("Example Ltd"))).toEqual([]);
  } finally {
    await removeWidget(id);
    await removeHost(host.id);
  }
});

test("the section is as tall as its content at 390px and 1440px, without inner or side scroll", async ({ page }) => {
  const host = await newHost();
  const id = await newWidget([host.id], { mode: "person" });
  try {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(hostPage(embedOrigin, id));
      await mountSection(page, {});
      const iframe = sectionFrame(page);
      await expect(iframe).toHaveAttribute("data-ready", "");
      const frame = iframe.contentFrame();
      await expect(frame.getByRole("heading", { level: 1 })).toHaveText("Discovery call");
      const content = async () => Math.ceil(await frame.locator("[data-widget-root]").evaluate((el) => el.getBoundingClientRect().height));
      await expect.poll(async () => Math.abs((await iframe.evaluate((el) => el.getBoundingClientRect().height)) - (await content()))).toBeLessThanOrEqual(1);
      expect(await frame.locator("html").evaluate((el) => el.scrollHeight <= window.innerHeight + 1)).toBe(true);
      await noSideScroll(page);
    }
  } finally {
    await removeWidget(id);
    await removeHost(host.id);
  }
});

test("widget.js is served with a short cache", async ({ request }) => {
  const response = await request.get("/widget.js");
  expect(response.ok()).toBe(true);
  expect(response.headers()["cache-control"]).toBe("public, max-age=300");
  expect(response.headers()["content-type"]).toMatch(/javascript/);
});
