"use server";

import { randomUUID } from "node:crypto";
import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { busyCacheTag, loadOffer } from "@/lib/availability/data";
import { getConfig } from "@/lib/config";
import { cleanBookingInput, eventSummary, looksLikeBot, roundRobinOrder, validateBooking } from "@/lib/core/booking";
import { addDays, dayStart, safeTimeZone, zonedDay } from "@/lib/core/dates";
import { validateAnswers } from "@/lib/core/questions";
import { readWidgetBookingPage, widgetConfirmationPath } from "@/lib/core/widget";
import { createAdminSupabase } from "@/lib/db/admin";
import { createEvent, deleteEvent, googleEventId } from "@/lib/google/calendar";
import { googleAccess } from "@/lib/google/connection";
import { type MessageKey, t } from "@/lib/i18n";
import { type ChannelRef, lastRoundRobinBookings, loadContext, type PublicSlot, publicSlots } from "./data";
import { withinLimit } from "./limit";
import { hashToken, newToken } from "./token";

// Book a time without login. Everything from the browser is checked again here; the time, duration, host and event type
// come from the database, never from the form. Errors are message keys the page translates; success redirects to the
// confirmation page.

// Untyped on purpose: it comes straight from the browser. answers: question id -> answer (string, or strings for multi).
export type BookingForm = {
  name?: unknown;
  email?: unknown;
  company?: unknown;
  phone?: unknown;
  topic?: unknown;
  privacy?: unknown;
  answers?: unknown;
  start?: unknown;
  timeZone?: unknown;
  honeypot?: unknown;
  startedAt?: unknown;
  // Widgets: the host page the booking came from (origin and path), checked against the widget's origins.
  bookingPage?: unknown;
};

export type BookingResult = {
  ok: false;
  error?: MessageKey;
  // Per field (name, email, privacy) and per question id ("answers.<id>").
  fieldErrors?: Record<string, MessageKey>;
  // After "taken": the fresh free times, so the page can offer them without a reload.
  slots?: PublicSlot[];
};

export async function bookSlot(ref: ChannelRef, form: BookingForm): Promise<BookingResult> {
  const config = getConfig();
  // A bot gets the generic error and costs no attempt.
  if (looksLikeBot({ honeypot: typeof form.honeypot === "string" ? form.honeypot : "", startedAt: Number(form.startedAt), now: Date.now() })) {
    return { ok: false, error: "booking.error.failed" };
  }
  if (!(await withinLimit(form.email))) return { ok: false, error: "booking.error.tooMany" };

  const context = await loadContext(ref).catch((cause) => {
    console.error("booking: context", cause);
    return null;
  });
  // Gone meanwhile (event type switched off, member no longer bookable, link used up, expired or revoked, widget switched
  // off) or the database failed.
  if (!context) return { ok: false, error: ref.kind === "link" ? "booking.error.linkInvalid" : ref.kind === "widget" ? "booking.error.widgetClosed" : "booking.error.failed" };
  if (context.hosts.length === 0) return { ok: false, error: "booking.error.taken", slots: [] };

  const input = cleanBookingInput(form);
  const answers = validateAnswers(context.eventType.questions, form.answers);
  const fieldErrors: Record<string, MessageKey> = { ...validateBooking(input, { privacyRequired: !!config.brand.privacyUrl }) };
  for (const [id, key] of Object.entries(answers.errors)) if (key) fieldErrors[`answers.${id}`] = key;
  if (Object.keys(fieldErrors).length) return { ok: false, fieldErrors };

  const start = new Date(typeof form.start === "string" ? form.start : NaN);
  if (Number.isNaN(start.getTime())) return { ok: false, error: "booking.error.taken" };
  const end = new Date(start.getTime() + context.eventType.durationMinutes * 60_000);
  const inviteeTimeZone = safeTimeZone(form.timeZone, config.timeZone);
  const db = createAdminSupabase();

  // Fresh free times, without the busy cache: the chosen start must still be free for at least one host.
  const hostIds = context.hosts.map((h) => h.id);
  const offer = await loadOffer(hostIds, context.eventType.durationMinutes, { fresh: true });
  // The chosen start is left out: it was not free, or someone else just got it.
  const taken = (): BookingResult => ({ ok: false, error: "booking.error.taken", slots: publicSlots(offer.slots.filter((s) => s.start !== start.toISOString())) });
  const free = offer.slots.find((s) => s.start === start.toISOString())?.hostIds ?? [];
  if (free.length === 0) return taken();

  // Cheap duplicate check before Google sends an invitation; create_booking checks again under a lock (P0003). A duplicate
  // gets the same answer as any other failure, whose text mentions the invitation: the page must not tell an anonymous
  // caller whether an email has an upcoming booking.
  const upcoming = await db
    .from("bookings")
    .select("id")
    .eq("event_type_id", context.eventType.id)
    .eq("invitee_email", input.email.toLowerCase())
    .eq("state", "booked")
    .gt("starts_at", new Date().toISOString())
    .limit(1);
  if (upcoming.error) return { ok: false, error: "booking.error.failed" };
  if (upcoming.data.length) return { ok: false, error: "booking.error.failed" };

  // Round robin among the hosts free at that time; the rest of the order is the fallback if a host's hold fails.
  let order = free;
  if (free.length > 1) {
    const last = await lastRoundRobinBookings(free).catch(() => new Map<string, string | null>());
    order = roundRobinOrder(context.hosts.filter((h) => free.includes(h.id)).map((h) => ({ id: h.id, name: h.name, lastBookingAt: last.get(h.id) ?? null })));
  }

  for (const hostId of order) {
    const availability = offer.availability.get(hostId);
    if (availability?.state !== "ok") continue;
    const host = context.hosts.find((h) => h.id === hostId)!;
    // The day of the start in the host's zone, for the daily maximum. dayStart: 01:00 where midnight does not exist.
    const day = zonedDay(start, availability.timeZone);
    const dayFrom = dayStart(day, availability.timeZone);
    const dayTo = dayStart(addDays(day, 1), availability.timeZone);
    if (!dayFrom || !dayTo) continue;

    const { data: hold, error: holdError } = await db.rpc("hold_slot", {
      p_host_id: hostId,
      p_starts_at: start.toISOString(),
      p_ends_at: end.toISOString(),
      p_buffer_minutes: availability.input.bufferMinutes,
      p_max_per_day: availability.input.maxBookingsPerDay,
      p_day_from: dayFrom.toISOString(),
      p_day_to: dayTo.toISOString(),
    });
    if (holdError || !hold) continue;
    const release = () => db.rpc("release_hold", { p_hold_id: hold }).then(() => undefined, () => undefined);

    const access = await googleAccess(hostId);
    if (!access.ok) {
      await release();
      continue;
    }

    const bookingId = randomUUID();
    const token = newToken();
    const summaryTemplate = await db.from("settings").select("value").eq("key", "event_summary_template").maybeSingle();
    const template = typeof summaryTemplate.data?.value === "string" && summaryTemplate.data.value.trim() ? summaryTemplate.data.value : t(config.locale, "booking.eventSummary");
    // Only what the invitee may see in their calendar: no answers, phone or topic in Google.
    let event: { id: string; meetUrl: string | null };
    try {
      event = await createEvent(access.token, availability.primaryCalendarId, {
        bookingId,
        summary: eventSummary(template, { event: context.eventType.title, invitee: input.name, host: host.name }),
        description: t(config.locale, "booking.eventDescription", { link: `${config.appUrl}/confirmed/${token}` }),
        start,
        end,
        timeZone: availability.timeZone,
        attendees: [{ email: input.email, displayName: input.name }],
        meet: host.meetAuto,
      });
    } catch (cause) {
      // The response may be lost after Google created the event (and sent the invitation). The id is ours, so take it
      // back without a cancellation mail; a 404/410 means there was nothing.
      console.error("booking: event insert", cause);
      await deleteEvent(access.token, availability.primaryCalendarId, googleEventId(bookingId), "none").catch((e) => console.error("booking: cleanup delete", e));
      await release();
      return { ok: false, error: "booking.error.failed" };
    }

    const { error } = await db.rpc("create_booking", {
      p_hold_id: hold,
      p_booking: {
        id: bookingId,
        event_type_id: context.eventType.id,
        host_id: hostId,
        starts_at: start.toISOString(),
        ends_at: end.toISOString(),
        booked_via: context.via,
        // Re-derived from the token on the server; create_booking checks the link again under its row lock.
        link_id: context.linkId ?? null,
        widget_id: context.widgetId ?? null,
        booking_page: context.widgetId ? readWidgetBookingPage(form.bookingPage, context.embedOrigins ?? []) : null,
        invitee_name: input.name,
        invitee_email: input.email,
        invitee_company: input.company,
        invitee_phone: input.phone,
        invitee_timezone: inviteeTimeZone,
        topic: input.topic,
        answers: answers.answers,
        google_event_id: event.id,
        meet_url: event.meetUrl,
        token_hash: hashToken(token),
        check_upcoming: true,
      },
    });
    if (error) {
      // Nothing was saved: take the event back without a cancellation mail, then free the time.
      await deleteEvent(access.token, availability.primaryCalendarId, event.id, "none").catch((cause) => console.error("booking: rollback delete", cause));
      await release();
      if (error.code === "P0003") return { ok: false, error: "booking.error.failed" };
      if (error.code === "P0004") return { ok: false, error: "booking.error.linkInvalid" };
      // The widget was switched off, lost this host or changed its event type after the page loaded.
      if (error.code === "P0005") return { ok: false, error: "booking.error.widgetClosed" };
      // The event type was switched off after the page loaded.
      if (error.code === "P0006") return { ok: false, error: "booking.error.widgetClosed" };
      if (error.code === "P0002") return taken();
      console.error("booking: create_booking", error);
      return { ok: false, error: "booking.error.failed" };
    }

    // The public pages must not offer this time from the busy cache any longer.
    updateTag(busyCacheTag(hostId));
    // M8 seams: plan the booking's jobs and send the confirmation mail here (after()). M9 delivers the outbox row that
    // create_booking already wrote.
    // Widget bookings stay inside the frame: /confirmed sends frame-ancestors 'none'.
    redirect(ref.kind === "widget" ? widgetConfirmationPath(ref.id, ref.view, token, true) : `/confirmed/${token}?new=1`);
  }

  // Every free host's hold failed (someone else was faster) or their Google access broke meanwhile.
  return taken();
}
