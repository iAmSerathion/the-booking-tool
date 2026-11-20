import { expect, test } from "@playwright/test";

test("home page renders on an unconfigured instance", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("the-booking-tool");
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
});

test("pages outside /widget cannot be framed", async ({ request }) => {
  const response = await request.get("/");
  expect(response.headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
});
