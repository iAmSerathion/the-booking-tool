import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { fillDetails, newHost, newPage, nextDay, noSideScroll, openDay, removeHost } from "./booking-helpers";
import { baseURL } from "./env";
import { admin, adminEmail, hostEmail, signInAs } from "./session";

// Event types end to end: an admin creates one with booking questions, an invitee picks it on a member page, must
// answer the required question and books; the answers reach the booking, the outbox and the admin Bookings list.
// Switched off, the type is no longer offered. Each run uses its own type (unique link name) and its own host; types
// are never deleted (bookings refer to them), so the test switches its type off at the end. The default event type is
// never changed here: other specs book it on "/" (set_default_event_type is covered by the DB and action tests).

const card = (page: Page, title: string) => page.getByRole("listitem", { name: title, exact: true });

test("an admin creates an event type with questions; an invitee picks it, must answer, books; switched off it is gone", async ({ page, context, browser }) => {
  const host = await newHost({ name: `Casey ${randomUUID().slice(0, 8)}` });
  const suffix = randomUUID().slice(0, 8);
  const slug = `e2e-${suffix}`;
  const title = `Workshop ${suffix}`;
  const invitee = await newPage(browser);
  try {
    await signInAs(context, baseURL, adminEmail);
    await page.goto("/app");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Event types" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Event types");

    // The default type has no switch; it must stay on.
    const meeting = card(page, "Meeting");
    await expect(meeting).toContainText("On · Default");
    await expect(meeting.getByRole("button", { name: /Switch off/ })).toHaveCount(0);
    await expect(meeting).toContainText("The default event type cannot be switched off.");

    const form = page.getByRole("region", { name: "New event type" });
    await form.getByLabel("Title").fill(title);
    await form.getByLabel("Link name").fill(slug);
    await form.getByLabel("Description").fill("Two hours to plan together.");
    await form.getByLabel("Duration in minutes").fill("45");
    await form.getByRole("button", { name: "Add question" }).click();
    const first = form.getByRole("group", { name: "Question 1" });
    await first.getByLabel("Label").fill("Team size");
    await first.getByLabel("Answer").selectOption({ label: "One choice" });
    await first.getByLabel("Choices").fill("1-5\n6-20\n\n21+");
    await first.getByLabel("Required").check();
    await form.getByRole("button", { name: "Add question" }).click();
    const second = form.getByRole("group", { name: "Question 2" });
    await second.getByLabel("Label").fill("Anything else?");
    await second.getByLabel("Answer").selectOption({ label: "Text" });

    // A choice question needs choices: refused with a message per question, the input stays.
    await first.getByLabel("Choices").fill(" ");
    await form.getByRole("button", { name: "Create event type" }).click();
    await expect(form.getByRole("alert")).toHaveText("Question 1 needs at least one choice.");
    await first.getByLabel("Choices").fill("1-5\n6-20\n\n21+");
    await form.getByRole("button", { name: "Create event type" }).click();
    await expect(form.getByRole("status")).toHaveText("Saved.");
    await expect(form.getByLabel("Title")).toHaveValue("");
    await expect(card(page, title)).toContainText("45 minutes");
    await expect(card(page, title)).toContainText("Team size (required), Anything else?");

    const { data: row } = await admin().from("event_types").select("id, title, duration_minutes, questions, active").eq("slug", slug).single();
    expect(row).toMatchObject({
      title,
      duration_minutes: 45,
      active: true,
      questions: [
        { id: "team-size", label: "Team size", type: "choice", choices: ["1-5", "6-20", "21+"], required: true },
        { id: "anything-else", label: "Anything else?", type: "text", required: false },
      ],
    });

    // Editing keeps the question ids, so stored answers and prefills still match.
    const item = card(page, title);
    await item.getByText("Edit").click();
    const edit = item.getByRole("group", { name: "Question 1" });
    await edit.getByLabel("Label").fill("How big is your team?");
    await item.getByLabel("Duration in minutes").fill("60");
    await item.getByRole("button", { name: "Save event type" }).click();
    await expect(item.locator("details").getByRole("status")).toHaveText("Saved.");
    await expect(item).toContainText("60 minutes");
    const { data: edited } = await admin().from("event_types").select("duration_minutes, questions").eq("id", row!.id).single();
    expect(edited!.duration_minutes).toBe(60);
    expect(edited!.questions.map((q: { id: string; label: string }) => [q.id, q.label])).toEqual([
      ["team-size", "How big is your team?"],
      ["anything-else", "Anything else?"],
    ]);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await noSideScroll(page);
    }

    // The invitee switches to the new type on the member page; the default stays what the bare URL books.
    await invitee.goto(`/${host.slug}`);
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText("Meeting");
    const types = invitee.getByRole("navigation", { name: "Event types" });
    await expect(types.getByRole("link", { name: /^Meeting/ })).toHaveAttribute("aria-current", "page");
    await types.getByRole("link", { name: `${title} 60 minutes` }).click();
    await expect(invitee).toHaveURL(new RegExp(`/${host.slug}\\?type=${slug}$`));
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(types.getByRole("link", { name: new RegExp(`^${title}`) })).toHaveAttribute("aria-current", "page");
    await expect(invitee.getByText("Two hours to plan together.")).toBeVisible();

    const day = nextDay([1, 2, 3, 4, 5]);
    await (await openDay(invitee, day)).getByRole("button", { name: "9:00 AM" }).click();
    const name = `Riley ${randomUUID().slice(0, 8)}`;
    const email = `invitee-${randomUUID()}@example.com`;
    await fillDetails(invitee, name, email);
    await invitee.getByRole("button", { name: "Book this time" }).click();
    await expect(invitee.getByText("Please answer this question.")).toBeVisible();
    await invitee.getByRole("group", { name: "How big is your team?" }).getByLabel("6-20").check();
    await invitee.getByLabel("Anything else?").fill("We use two calendars.");
    await invitee.getByRole("button", { name: "Book this time" }).click();
    await expect(invitee).toHaveURL(/\/confirmed\/[\w-]{43}\?new=1$/);
    await noSideScroll(invitee);

    const answers = [
      { id: "team-size", question: "How big is your team?", answer: "6-20" },
      { id: "anything-else", question: "Anything else?", answer: "We use two calendars." },
    ];
    const { data: booking } = await admin().from("bookings").select("id, event_type_id, answers, starts_at, ends_at").eq("host_id", host.id).single();
    expect(booking).toMatchObject({ event_type_id: row!.id, answers });
    expect(new Date(booking!.ends_at).getTime() - new Date(booking!.starts_at).getTime()).toBe(60 * 60_000);
    const { data: outbox } = await admin().from("booking_outbox").select("type, payload").eq("booking_id", booking!.id);
    expect(outbox).toEqual([{ type: "booking.created", payload: expect.objectContaining({ event_type_id: row!.id, answers }) }]);

    // The admin Bookings list shows the answers.
    await page.goto("/app/bookings");
    const listed = page.getByRole("listitem").filter({ hasText: name });
    await expect(listed).toContainText(title);
    await expect(listed).toContainText("How big is your team?");
    await expect(listed).toContainText("6-20");
    await expect(listed).toContainText("We use two calendars.");

    // Switched off: no longer offered, and its URL is the 404 page.
    await page.goto("/app/event-types");
    await card(page, title).getByRole("button", { name: `Switch off ${title}` }).click();
    await expect(card(page, title)).toContainText("Off");
    await expect(card(page, title).getByRole("button", { name: `Switch on ${title}` })).toBeVisible();
    await expect(card(page, title).getByRole("button", { name: `Make ${title} the default` })).toHaveCount(0);
    await invitee.goto(`/${host.slug}`);
    await expect(invitee.getByRole("heading", { level: 1 })).toHaveText("Meeting");
    await expect(invitee.getByRole("link", { name: new RegExp(`^${title}`) })).toHaveCount(0);
    for (const path of [`/${host.slug}?type=${slug}`, `/?type=${slug}`]) {
      await invitee.goto(path);
      await expect(invitee.getByRole("heading", { level: 1 }), path).toHaveText("Page not found");
    }
  } finally {
    await admin().from("event_types").update({ active: false }).eq("slug", slug);
    await invitee.context().close();
    await removeHost(host.id);
  }
});

test("members cannot open the event type admin or change event types", async ({ page, context }) => {
  await signInAs(context, baseURL, hostEmail);
  await page.goto("/app");
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Event types" })).toHaveCount(0);
  // The status stays 200 once the page streams; the 404 page is what counts.
  await page.goto("/app/event-types");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
});
