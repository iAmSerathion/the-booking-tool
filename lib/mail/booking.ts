import { hashToken, newToken } from "@/lib/booking/token";
import { type Locale, getConfig } from "@/lib/config";
import { slotLong, timeZoneLabel } from "@/lib/core/booking";
import { createAdminSupabase } from "@/lib/db/admin";
import { t } from "@/lib/i18n";
import { composeMail, type Paragraph } from "./compose";
import { sendMail } from "./send";

// The mails around a booking: confirmation and host notice, new time, cancellation, each to the invitee and the host.
// Called from after(), once the change has committed; they read the booking fresh and never throw (failures are logged,
// and sendMail retries a failed delivery). Links come from APP_URL only. send_keys: "<kind>:<booking id>" plus the
// reschedule count for a new time, so every occasion goes out once. Invitee mails reply to the host, host mails to the
// invitee. Server code only.

type MailBooking = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  inviteeName: string;
  inviteeEmail: string;
  inviteeCompany: string | null;
  inviteePhone: string | null;
  inviteeTimeZone: string;
  topic: string | null;
  answers: { question: string; answer: string | string[] }[];
  meetUrl: string | null;
  googleEventId: string | null;
  rescheduleCount: number;
  event: string;
  host: { name: string; email: string; timeZone: string };
};

async function loadBooking(id: string): Promise<MailBooking> {
  const { data, error } = await createAdminSupabase()
    .from("bookings")
    .select(
      "id, starts_at, ends_at, invitee_name, invitee_email, invitee_company, invitee_phone, invitee_timezone, topic, answers, meet_url, google_event_id, reschedule_count, profiles(name, email, timezone), event_types(title)",
    )
    .eq("id", id)
    .single();
  if (error) throw error;
  // One-to-one joins; supabase-js types them as arrays without generated database types.
  const host = data.profiles as unknown as { name: string; email: string; timezone: string };
  return {
    id: data.id,
    startsAt: new Date(data.starts_at),
    endsAt: new Date(data.ends_at),
    inviteeName: data.invitee_name,
    inviteeEmail: data.invitee_email,
    inviteeCompany: data.invitee_company,
    inviteePhone: data.invitee_phone,
    inviteeTimeZone: data.invitee_timezone ?? host.timezone,
    topic: data.topic,
    answers: data.answers ?? [],
    meetUrl: data.meet_url,
    googleEventId: data.google_event_id,
    rescheduleCount: data.reschedule_count,
    event: (data.event_types as unknown as { title: string }).title,
    host: { name: host.name, email: host.email, timeZone: host.timezone },
  };
}

const when = (start: Date, end: Date, timeZone: string, locale: Locale) => `${slotLong(start, end, timeZone, locale)} (${timeZoneLabel(timeZone, start, locale)})`;

// Sends each mail on its own: one failure does not stop the others.
async function sendAll(label: string, build: () => Promise<Parameters<typeof sendMail>[0][]>) {
  try {
    const results = await Promise.allSettled((await build()).map(sendMail));
    for (const result of results) if (result.status === "rejected") console.error(`mail: ${label}`, result.reason);
  } catch (cause) {
    console.error(`mail: ${label}`, cause);
  }
}

function mails(b: MailBooking) {
  const { appUrl, locale, brand } = getConfig();
  const footer = [t(locale, "mail.footer", { brand: brand.name })];
  const inviteeWhen = (start = b.startsAt, end = b.endsAt) => when(start, end, b.inviteeTimeZone, locale);
  const hostWhen = (start = b.startsAt, end = b.endsAt) => when(start, end, b.host.timeZone, locale);
  const short = { event: b.event, host: b.host.name, invitee: b.inviteeName };
  // The only URLs that become links in the HTML: ours from APP_URL and the Meet link, never one inside invitee text.
  const links: string[] = [];
  const link = (url: string) => (links.push(url), url);

  const invitee = (kind: string, subject: string, paragraphs: Paragraph[], sendUntil: Date | null = b.startsAt) => ({
    sendKey: kind,
    bookingId: b.id,
    to: b.inviteeEmail,
    replyTo: b.host.email,
    subject,
    sendUntil,
    ...composeMail([[t(locale, "mail.greeting", { name: b.inviteeName })], ...paragraphs, footer], links),
  });
  const host = (kind: string, subject: string, paragraphs: Paragraph[]) => ({
    sendKey: kind,
    bookingId: b.id,
    to: b.host.email,
    replyTo: b.inviteeEmail,
    subject,
    sendUntil: b.startsAt,
    ...composeMail([...paragraphs, [t(locale, "mail.bookings", { link: link(`${appUrl}/app/bookings`) })], footer], links),
  });

  const facts = (before?: { startsAt: Date; endsAt: Date }): Paragraph => [
    t(locale, "mail.what", { event: b.event }),
    t(locale, "mail.when", { when: inviteeWhen() }),
    before && t(locale, "mail.before", { when: inviteeWhen(before.startsAt, before.endsAt) }),
    t(locale, "mail.with", { host: b.host.name }),
    b.meetUrl?.startsWith("https://") && t(locale, "mail.meet", { link: link(b.meetUrl) }),
    // Google already invited the invitee to the event (sendUpdates=all); an .ics as well would add a second entry.
    b.googleEventId && t(locale, "mail.invitation"),
  ];
  const changeLinks = (token: string): Paragraph => [
    t(locale, "mail.reschedule", { link: link(`${appUrl}/reschedule/${token}`) }),
    t(locale, "mail.cancel", { link: link(`${appUrl}/cancel/${token}`) }),
  ];
  const person: Paragraph = [
    t(locale, "mail.name", { name: b.inviteeName }),
    t(locale, "mail.email", { email: b.inviteeEmail }),
    b.inviteeCompany && t(locale, "mail.company", { company: b.inviteeCompany }),
    b.inviteePhone && t(locale, "mail.phone", { phone: b.inviteePhone }),
  ];
  return { locale, appUrl, link, short, invitee, host, facts, changeLinks, person, inviteeWhen, hostWhen };
}

export function sendConfirmationMails(bookingId: string, token: string) {
  return sendAll("confirmation", async () => {
    const b = await loadBooking(bookingId);
    const m = mails(b);
    const { locale } = m;
    return [
      m.invitee(`confirmation:${b.id}`, t(locale, "mail.confirmation.subject", m.short), [[t(locale, "mail.confirmation.intro")], m.facts(), m.changeLinks(token)]),
      m.host(`host_notice:${b.id}`, t(locale, "mail.hostNotice.subject", { ...m.short, when: m.hostWhen() }), [
        [t(locale, "mail.hostNotice.intro", m.short)],
        [t(locale, "mail.when", { when: m.hostWhen() }), ...m.person, b.topic && t(locale, "mail.topic", { topic: b.topic })],
        b.answers.map((a) => `${a.question}: ${Array.isArray(a.answer) ? a.answer.join(", ") : a.answer}`),
      ]),
    ];
  });
}

// previous: the times before the move, as read before reschedule_booking.
export function sendRescheduleMails(bookingId: string, token: string, previous: { startsAt: string; endsAt: string }) {
  return sendAll("reschedule", async () => {
    const b = await loadBooking(bookingId);
    const m = mails(b);
    const { locale } = m;
    const before = { startsAt: new Date(previous.startsAt), endsAt: new Date(previous.endsAt) };
    return [
      m.invitee(`rescheduled:${b.id}:${b.rescheduleCount}`, t(locale, "mail.rescheduled.subject", m.short), [
        [t(locale, "mail.rescheduled.intro")],
        m.facts(before),
        m.changeLinks(token),
      ]),
      m.host(`rescheduled_host:${b.id}:${b.rescheduleCount}`, t(locale, "mail.rescheduledHost.subject", { ...m.short, when: m.hostWhen() }), [
        [t(locale, "mail.rescheduledHost.intro", m.short)],
        [t(locale, "mail.when", { when: m.hostWhen() }), t(locale, "mail.before", { when: m.hostWhen(before.startsAt, before.endsAt) }), ...m.person],
      ]),
    ];
  });
}

// by: who cancelled. A host who cancelled their own booking gets no notice; an admin's cancel is told to the host.
// token: the invitee's token if at hand, else a new booking_tokens row is made for the rebook link (only hashes are
// stored, so the booking's own token cannot be rebuilt).
export function sendCancelMails(bookingId: string, { by, reason, token, notifyHost }: { by: "invitee" | "host" | "admin"; reason: string | null; token?: string; notifyHost: boolean }) {
  return sendAll("cancel", async () => {
    const b = await loadBooking(bookingId);
    const m = mails(b);
    const { locale } = m;
    let link = token;
    if (!link) {
      link = newToken();
      const { error } = await createAdminSupabase().from("booking_tokens").insert({ token_hash: hashToken(link), booking_id: b.id });
      if (error) throw error;
    }
    const reasonLine = reason && t(locale, "mail.reason", { reason });
    const out = [
      m.invitee(
        `cancelled:${b.id}`,
        t(locale, "mail.cancelled.subject", m.short),
        [
          [by === "invitee" ? t(locale, "mail.cancelled.intro") : t(locale, "mail.cancelled.introByHost", m.short)],
          [t(locale, "mail.what", { event: b.event }), t(locale, "mail.when", { when: m.inviteeWhen() }), t(locale, "mail.with", { host: b.host.name }), reasonLine],
          [t(locale, "mail.rebook", { link: m.link(`${m.appUrl}/cancel/${link}/new`) })],
        ],
        null,
      ),
    ];
    if (notifyHost)
      out.push(
        m.host(`cancelled_host:${b.id}`, t(locale, "mail.cancelledHost.subject", { ...m.short, when: m.hostWhen() }), [
          [t(locale, by === "admin" ? "mail.cancelledHost.introByAdmin" : "mail.cancelledHost.intro", m.short)],
          [t(locale, "mail.when", { when: m.hostWhen() }), ...m.person, reasonLine],
        ]),
      );
    return out;
  });
}

// A fresh booking_tokens row for a mail's links, or null when a mail with this send_key exists already, so a repeat
// leaves no orphan tokens.
async function freshToken(bookingId: string, sendKey: string): Promise<string | null> {
  const db = createAdminSupabase();
  const { data: existing, error: readError } = await db.from("outbound_mails").select("id").eq("send_key", sendKey).maybeSingle();
  if (readError) throw readError;
  if (existing) return null;
  const token = newToken();
  const { error } = await db.from("booking_tokens").insert({ token_hash: hashToken(token), booking_id: bookingId });
  if (error) throw error;
  return token;
}

// A reminder from a scheduler job. send_key "<step>:<booking id>:<planned start>": after a reschedule the reminder goes
// out again for the new time, never twice for one time. Each reminder carries a fresh booking_tokens row for its links.
// Throws, so the job is retried; a failed delivery is sendMail's retry.
export async function sendReminderMail(bookingId: string, { stepKey, plannedFor, sendUntil }: { stepKey: string; plannedFor: Date; sendUntil: Date }) {
  const sendKey = `${stepKey}:${bookingId}:${plannedFor.toISOString()}`;
  const token = await freshToken(bookingId, sendKey);
  if (!token) return "duplicate";
  const b = await loadBooking(bookingId);
  const m = mails(b);
  return sendMail(m.invitee(sendKey, t(m.locale, "mail.reminder.subject", m.short), [[t(m.locale, "mail.reminder.intro")], m.facts(), m.changeLinks(token)], sendUntil));
}

// The host moved the booking in Google (calendar sync). The reschedule count stays on such a move, so the send_key
// "calendar_moved:<booking id>:<new start>" carries the new start: each move goes out once, also when a deferred sync
// sees it again. To the invitee only, with fresh links; the host made the move. Never throws.
export function sendCalendarMoveMail(bookingId: string, previous: { startsAt: Date; endsAt: Date }) {
  return sendAll("calendar move", async () => {
    const b = await loadBooking(bookingId);
    const sendKey = `calendar_moved:${b.id}:${b.startsAt.toISOString()}`;
    const token = await freshToken(b.id, sendKey);
    if (!token) return [];
    const m = mails(b);
    return [m.invitee(sendKey, t(m.locale, "mail.rescheduled.subject", m.short), [[t(m.locale, "mail.calendarMoved.intro", m.short)], m.facts(previous), m.changeLinks(token)])];
  });
}
