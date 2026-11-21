import { beforeEach, describe, expect, it, vi } from "vitest";

// What each booking mail says, to whom, with which send_key and send_until; the booking row and sendMail are stubbed.

const state = vi.hoisted(() => ({ sent: [] as Record<string, unknown>[], tokens: [] as Record<string, unknown>[], row: {} as Record<string, unknown>, existing: null as unknown }));

vi.mock("@/lib/config", () => ({ getConfig: () => ({ appUrl: "https://book.example.com", locale: "en", brand: { name: "Acme Bookings" } }) }));
vi.mock("./send", () => ({ sendMail: async (mail: Record<string, unknown>) => (state.sent.push(mail), "sent") }));
vi.mock("@/lib/db/admin", () => ({
  createAdminSupabase: () => ({
    from: (table: string) =>
      table === "bookings"
        ? { select: () => ({ eq: () => ({ single: async () => ({ data: state.row, error: null }) }) }) }
        : table === "outbound_mails"
          ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.existing, error: null }) }) }) }
          : { insert: async (row: Record<string, unknown>) => (state.tokens.push(row), { error: null }) },
  }),
}));

const { sendCalendarMoveMail, sendCancelMails, sendConfirmationMails, sendReminderMail, sendRescheduleMails } = await import("./booking");
const { hashToken } = await import("@/lib/booking/token");

const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => {
  state.sent = [];
  state.tokens = [];
  state.existing = null;
  state.row = {
    id,
    starts_at: "2030-01-07T09:00:00Z",
    ends_at: "2030-01-07T09:30:00Z",
    invitee_name: "Ada <b>Example</b>",
    invitee_email: "ada@example.com",
    invitee_company: null,
    invitee_phone: "+1 555 0100",
    invitee_timezone: "America/New_York",
    topic: "Pricing",
    answers: [{ question: "Team size?", answer: ["1-10", "11-50"] }],
    meet_url: "https://meet.google.com/abc-defg-hij",
    google_event_id: "event1",
    reschedule_count: 2,
    profiles: { name: "Riley Host", email: "riley@example.com", timezone: "Europe/Berlin" },
    event_types: { title: "Intro call" },
  };
});

const byKey = (key: string) => state.sent.find((m) => m.sendKey === key)!;

describe("booking mails", () => {
  it("confirm to the invitee in their zone with APP_URL links, and tell the host in theirs", async () => {
    await sendConfirmationMails(id, "tok");
    expect(state.sent.map((m) => [m.sendKey, m.to, m.replyTo])).toEqual([
      [`confirmation:${id}`, "ada@example.com", "riley@example.com"],
      [`host_notice:${id}`, "riley@example.com", "ada@example.com"],
    ]);
    const invitee = byKey(`confirmation:${id}`);
    expect(invitee).toMatchObject({ bookingId: id, subject: "Confirmed: Intro call with Riley Host", sendUntil: new Date("2030-01-07T09:00:00Z") });
    expect(invitee.text).toBe(
      [
        "Hello Ada <b>Example</b>,",
        "your booking is confirmed.",
        "What: Intro call\nWhen: Monday, January 7, 2030, 4:00 AM to 4:30 AM (America/New_York (EST))\nWith: Riley Host\nVideo call: https://meet.google.com/abc-defg-hij\nThe calendar invitation comes from Google in a separate email.",
        "Reschedule: https://book.example.com/reschedule/tok\nCancel: https://book.example.com/cancel/tok",
        "Sent by Acme Bookings",
      ].join("\n\n"),
    );
    expect(invitee.html).toContain("Hello Ada &lt;b&gt;Example&lt;/b&gt;,");
    expect(invitee.html).toContain('<a href="https://book.example.com/reschedule/tok">');
    expect(invitee.html).toContain('<a href="https://meet.google.com/abc-defg-hij">');

    const host = byKey(`host_notice:${id}`);
    expect(host.subject).toBe("New booking: Ada <b>Example</b>, Monday, January 7, 2030, 10:00 AM to 10:30 AM (Europe/Berlin (GMT+1))");
    expect(host.text).toContain("Phone: +1 555 0100\nTopic: Pricing\n\nTeam size?: 1-10, 11-50\n\nAll bookings: https://book.example.com/app/bookings");
    expect(host.text).not.toContain("Company:");
  });

  it("never link a URL the invitee typed, in the invitee's mail or the host's", async () => {
    state.row = { ...state.row, invitee_name: "Please verify at https://evil.example.com/login", topic: "https://evil.example.com/topic" };
    state.row.answers = [{ question: "Site?", answer: "https://evil.example.com/answer" }];
    await sendConfirmationMails(id, "tok");
    for (const mail of state.sent) {
      expect(mail.html).toContain("https://evil.example.com/");
      expect(mail.html).not.toContain('href="https://evil');
    }
    expect(byKey(`host_notice:${id}`).html).toContain('<a href="https://book.example.com/app/bookings">');
  });

  it("drop the Meet and invitation lines when the booking has neither", async () => {
    state.row = { ...state.row, meet_url: null, google_event_id: null };
    await sendConfirmationMails(id, "tok");
    expect(byKey(`confirmation:${id}`).text).not.toMatch(/Video call|invitation/);
  });

  it("send a new time once per reschedule, with the time before", async () => {
    await sendRescheduleMails(id, "tok", { startsAt: "2030-01-06T15:00:00Z", endsAt: "2030-01-06T15:30:00Z" });
    expect(state.sent.map((m) => m.sendKey)).toEqual([`rescheduled:${id}:2`, `rescheduled_host:${id}:2`]);
    expect(byKey(`rescheduled:${id}:2`).text).toContain("Before: Sunday, January 6, 2030, 10:00 AM to 10:30 AM (America/New_York (EST))");
    expect(byKey(`rescheduled_host:${id}:2`).text).toContain("Before: Sunday, January 6, 2030, 4:00 PM to 4:30 PM (Europe/Berlin (GMT+1))");
  });

  it("send the invitee's cancellation with a rebook link and the reason to both sides", async () => {
    await sendCancelMails(id, { by: "invitee", reason: "Sick", token: "tok", notifyHost: true });
    expect(state.sent.map((m) => [m.sendKey, m.sendUntil])).toEqual([
      [`cancelled:${id}`, null],
      [`cancelled_host:${id}`, new Date("2030-01-07T09:00:00Z")],
    ]);
    expect(byKey(`cancelled:${id}`).text).toContain("your booking is cancelled.\n\nWhat: Intro call");
    expect(byKey(`cancelled:${id}`).text).toContain("Reason: Sick\n\nBook a new time: https://book.example.com/cancel/tok/new");
    expect(byKey(`cancelled_host:${id}`).text).toContain("Ada <b>Example</b> cancelled the booking.");
    expect(state.tokens).toEqual([]);
  });

  it("tell only the invitee when the host cancelled, with a fresh link token", async () => {
    await sendCancelMails(id, { by: "host", reason: null, notifyHost: false });
    expect(state.sent.map((m) => m.sendKey)).toEqual([`cancelled:${id}`]);
    const text = byKey(`cancelled:${id}`).text as string;
    expect(text).toContain("Riley Host cancelled your booking.");
    expect(text).not.toContain("Reason:");
    const token = /cancel\/([\w-]+)\/new/.exec(text)![1];
    expect(byKey(`cancelled:${id}`).html).toContain(`<a href="https://book.example.com/cancel/${token}/new">`);
    expect(state.tokens).toEqual([{ token_hash: hashToken(token), booking_id: id }]);
  });

  it("tell the host when an admin cancelled their booking", async () => {
    await sendCancelMails(id, { by: "admin", reason: null, notifyHost: true });
    expect(byKey(`cancelled_host:${id}`).text).toContain("The booking with Ada <b>Example</b> was cancelled by an admin.");
  });

  it("remind the invitee once per planned start, with links from a fresh token", async () => {
    const plannedFor = new Date("2030-01-07T09:00:00Z");
    const sendUntil = new Date("2030-01-07T08:00:00Z");
    expect(await sendReminderMail(id, { stepKey: "reminder_1440m", plannedFor, sendUntil })).toBe("sent");
    const [mail] = state.sent;
    expect(mail).toMatchObject({ sendKey: `reminder_1440m:${id}:2030-01-07T09:00:00.000Z`, to: "ada@example.com", replyTo: "riley@example.com", sendUntil });
    expect(mail.subject).toBe("Reminder: Intro call with Riley Host");
    expect(mail.text).toContain("a reminder of your upcoming booking.");
    const token = (mail.text as string).match(/reschedule\/([\w-]+)/)![1];
    expect(state.tokens).toEqual([{ token_hash: hashToken(token), booking_id: id }]);

    // A second run for the same start makes no token and no mail.
    state.existing = { id: "row" };
    expect(await sendReminderMail(id, { stepKey: "reminder_1440m", plannedFor, sendUntil })).toBe("duplicate");
    expect(state.sent).toHaveLength(1);
    expect(state.tokens).toHaveLength(1);
  });

  it("tell the invitee once about a move the host made in the calendar, with the time before and fresh links", async () => {
    await sendCalendarMoveMail(id, { startsAt: new Date("2030-01-06T15:00:00Z"), endsAt: new Date("2030-01-06T15:30:00Z") });
    const [mail] = state.sent;
    expect(mail).toMatchObject({ sendKey: `calendar_moved:${id}:2030-01-07T09:00:00.000Z`, to: "ada@example.com", replyTo: "riley@example.com" });
    expect(mail.sendUntil).toEqual(new Date("2030-01-07T09:00:00Z"));
    expect(mail.subject).toBe("New time: Intro call with Riley Host");
    expect(mail.text).toContain("Riley Host moved your booking to a new time.");
    expect(mail.text).toContain("Before: Sunday, January 6, 2030, 10:00 AM to 10:30 AM (America/New_York (EST))");
    const token = (mail.text as string).match(/reschedule\/([\w-]+)/)![1];
    expect(state.tokens).toEqual([{ token_hash: hashToken(token), booking_id: id }]);

    state.existing = { id: "row" };
    await sendCalendarMoveMail(id, { startsAt: new Date("2030-01-06T15:00:00Z"), endsAt: new Date("2030-01-06T15:30:00Z") });
    expect(state.sent).toHaveLength(1);
    expect(state.tokens).toHaveLength(1);
  });
});
