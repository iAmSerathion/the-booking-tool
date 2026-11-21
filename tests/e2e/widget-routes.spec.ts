import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { bookingsOf, fillDetails, newHost, newPage, nextDay, noSideScroll, openDay, removeHost, zone } from "./booking-helpers";
import { baseURL, embedOrigin } from "./env";
import { admin } from "./session";

// Widget pages opened directly (the embedding itself is in widget.spec.ts): the per-request frame-ancestors from the
// widget row, the closed view, and booking through a widget. Every test creates its own hosts and widget; the seeded
// widget is left alone.

test.use({ timezoneId: zone, locale: "en-US" });

const discoveryCall = "00000000-0000-4000-8000-000000000101";
const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const closed = "Booking here is not possible right now";

async function newWidget(hostIds: string[], { mode = "round_robin", active = true, origins = [embedOrigin] } = {}) {
  const { data, error } = await admin()
    .from("booking_widgets")
    .insert({ name: `Widget ${randomUUID().slice(0, 8)}`, mode, event_type_id: discoveryCall, allowed_origins: origins, active })
    .select("id")
    .single();
  if (error) throw error;
  if (hostIds.length) {
    const { error: hostError } = await admin().from("booking_widget_hosts").insert(hostIds.map((user_id) => ({ widget_id: data.id, user_id })));
    if (hostError) throw hostError;
  }
  return data.id as string;
}
// Bookings keep the row (widget_id is ON DELETE SET NULL); the hosts go with removeHost afterwards.
const removeWidget = (id: string) => admin().from("booking_widgets").delete().eq("id", id);

async function book(page: Page, path: string, day: string, time: string) {
  await page.goto(path);
  await (await openDay(page, day)).getByRole("button", { name: time }).click();
  await page.getByRole("radio", { name: "Pricing" }).check();
  await fillDetails(page, "Robin Invitee", `invitee-${randomUUID()}@example.com`);
  await page.getByRole("button", { name: "Book this time" }).click();
}

test("widget pages get frame-ancestors from the widget row; inactive, unknown and malformed widgets get 'none'; other pages keep the static deny", async ({ request }) => {
  const host = await newHost();
  const active = await newWidget([host.id]);
  const inactive = await newWidget([host.id], { active: false });
  const fallback = await newWidget([host.id], { origins: [] });
  try {
    for (const path of [`/widget/${active}`, `/widget/${active}/section`, `/widget/${active}/confirmed/${"A".repeat(43)}`]) {
      const response = await request.get(path);
      expect(response.headers()["content-security-policy"], path).toBe(`frame-ancestors ${embedOrigin} ${baseURL}`);
      expect(response.headers()["x-frame-options"], path).toBeUndefined();
      expect(response.headers()["set-cookie"], path).toBeUndefined();
    }
    // No origins of its own and no EMBED_ALLOWED_ORIGINS in the e2e server: only the instance itself (the playground).
    expect((await request.get(`/widget/${fallback}`)).headers()["content-security-policy"]).toBe(`frame-ancestors ${baseURL}`);

    for (const path of [`/widget/${inactive}`, `/widget/${inactive}/section`, `/widget/${randomUUID()}`, "/widget/not-a-widget", `/widget/${active}x`]) {
      const response = await request.get(path);
      expect(response.headers()["content-security-policy"], path).toBe("frame-ancestors 'none'");
      expect(response.headers()["x-frame-options"], path).toBeUndefined();
    }

    // Switching a widget off applies on the next request, no cache in between.
    await admin().from("booking_widgets").update({ active: false }).eq("id", active);
    expect((await request.get(`/widget/${active}`)).headers()["content-security-policy"]).toBe("frame-ancestors 'none'");

    for (const path of ["/", "/widget", "/app", "/login", `/confirmed/${"A".repeat(43)}`]) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.headers()["content-security-policy"], path).toBe("frame-ancestors 'none'");
      expect(response.headers()["x-frame-options"], path).toBe("DENY");
    }
  } finally {
    for (const id of [active, inactive, fallback]) await removeWidget(id);
    await removeHost(host.id);
  }
});

test("inactive, unknown and host-less widgets show the closed view in window and section", async ({ page }) => {
  const host = await newHost();
  const inactive = await newWidget([host.id], { active: false });
  const empty = await newWidget([]);
  try {
    for (const id of [inactive, empty, randomUUID(), "not-a-widget"]) {
      await page.goto(`/widget/${id}`);
      await expect(heading(page)).toHaveText(closed);
      await page.goto(`/widget/${id}/section`);
      await expect(heading(page)).toHaveText(closed);
      await expect(page.getByRole("banner")).toHaveCount(0);
    }
  } finally {
    for (const id of [inactive, empty]) await removeWidget(id);
    await removeHost(host.id);
  }
});

test("a round robin widget books only its own hosts, via widget with its id, and confirms inside the widget path", async ({ page, browser }) => {
  const first = await newHost({ name: "Quinn Host" });
  const second = await newHost({ name: "Riley Host" });
  // Bookable, but not a host of this widget: never booked through it.
  const outsider = await newHost({ name: "Aaron Outsider" });
  const id = await newWidget([first.id, second.id]);
  const other = await newPage(browser);
  try {
    const day = nextDay([1, 2, 3, 4, 5]);
    await book(page, `/widget/${id}`, day, "9:00 AM");
    await expect(page).toHaveURL(new RegExp(`/widget/${id}/confirmed/[\\w-]{43}\\?new=1$`));
    await expect(heading(page)).toHaveText("Your booking is confirmed.");
    await expect(page.getByRole("banner")).toBeVisible();
    // The change pages cannot be framed, so they open in a new tab.
    for (const name of ["Reschedule", "Cancel"]) await expect(page.getByRole("link", { name })).toHaveAttribute("target", "_blank");

    // The same time again: the other widget host is free and next in turn.
    await book(other, `/widget/${id}`, day, "9:00 AM");
    await expect(heading(other)).toHaveText("Your booking is confirmed.");

    const rows = [...(await bookingsOf(first.id)), ...(await bookingsOf(second.id))];
    expect(rows.map((r) => r.host_id).sort()).toEqual([first.id, second.id].sort());
    expect(await bookingsOf(outsider.id)).toEqual([]);
    const { data } = await admin().from("bookings").select("booked_via, widget_id, event_type_id").in("id", rows.map((r) => r.id));
    expect(data).toEqual([
      { booked_via: "widget", widget_id: id, event_type_id: discoveryCall },
      { booked_via: "widget", widget_id: id, event_type_id: discoveryCall },
    ]);
  } finally {
    await other.context().close();
    await removeWidget(id);
    for (const host of [first, second, outsider]) await removeHost(host.id);
  }
});

test("a person widget books its one host in the section, without header, and fits 390px and 1440px", async ({ page }) => {
  const host = await newHost({ name: "Sage Host" });
  const id = await newWidget([host.id], { mode: "person" });
  try {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/widget/${id}/section`);
      await expect(heading(page)).toHaveText("Discovery call");
      await expect(page.getByText("with Sage Host")).toBeVisible();
      await expect(page.getByRole("banner")).toHaveCount(0);
      await noSideScroll(page);
    }
    await book(page, `/widget/${id}/section`, nextDay([1, 2, 3, 4, 5]), "10:00 AM");
    await expect(page).toHaveURL(new RegExp(`/widget/${id}/section/confirmed/[\\w-]{43}\\?new=1$`));
    await expect(heading(page)).toHaveText("Your booking is confirmed.");
    await expect(page.getByRole("banner")).toHaveCount(0);
    const [booking, ...more] = await bookingsOf(host.id);
    expect(more).toEqual([]);
    expect(booking.booked_via).toBe("widget");
  } finally {
    await removeWidget(id);
    await removeHost(host.id);
  }
});
