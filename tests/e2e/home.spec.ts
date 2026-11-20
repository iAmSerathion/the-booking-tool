import { expect, test } from "@playwright/test";

test("brand and locale come from the environment at runtime", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Acme Bookings");
  await expect(page).toHaveTitle("Acme Bookings");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("pages outside /widget cannot be framed", async ({ request }) => {
  const response = await request.get("/");
  expect(response.headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
});

test("every response sends baseline security headers", async ({ request }) => {
  const headers = (await request.get("/")).headers();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["x-powered-by"]).toBeUndefined();
});
