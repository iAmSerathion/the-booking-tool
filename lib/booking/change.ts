"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { busyCacheTag } from "@/lib/availability/data";
import { getConfig } from "@/lib/config";
import { bookingChange, cancelReason } from "@/lib/core/change";
import { addDays, dayStart, safeTimeZone, zonedDay } from "@/lib/core/dates";
import { createAdminSupabase } from "@/lib/db/admin";
import { moveEvent } from "@/lib/google/calendar";
import { googleAccess } from "@/lib/google/connection";
import type { MessageKey } from "@/lib/i18n";
import { type Confirmation, loadConfirmation, loadRescheduleOffer, type PublicSlot } from "./data";
import { removeBookingEvent } from "./google";
import { withinLimit } from "./limit";

// Reschedule and cancel without login, through the booking's token. The pages bind the token on the server; everything
// else (booking, host, calendar, times) is derived from it again here. A booking that is no longer open (cancelled, past,
// unknown) sends the browser back to the page, which shows the closed view or the 404 page.

// Untyped on purpose: it comes straight from the browser.
export type RescheduleForm = { start?: unknown; timeZone?: unknown };
export type RescheduleResult = { ok: false; error: MessageKey; slots?: PublicSlot[] };

// While google_change_until lies in the future, the calendar sync (M8) ignores Google changes to the booking, and a
// second change of the same booking waits. hold_slot does not lock the booking itself: without this, two reschedules of
// one booking could move the Google event in one order and commit in the other.
const leaseSeconds = 120;

async function takeLease(bookingId: string): Promise<boolean> {
  const now = new Date();
  const { data, error } = await createAdminSupabase()
    .from("bookings")
    .update({ google_change_until: new Date(now.getTime() + leaseSeconds * 1000).toISOString() })
    .eq("id", bookingId)
    .or(`google_change_until.is.null,google_change_until.lt.${now.toISOString()}`)
    .select("id");
  return !error && data.length === 1;
}

async function dropLease(bookingId: string) {
  const { error } = await createAdminSupabase().from("bookings").update({ google_change_until: null }).eq("id", bookingId);
  if (error) console.error("booking: lease release", error);
}

const isOpen = (booking: Confirmation | null): booking is Confirmation => !!booking && bookingChange(booking, new Date()) === "open";

export async function rescheduleBooking(token: string, form: RescheduleForm): Promise<RescheduleResult> {
  const booking = await loadConfirmation(token);
  if (!isOpen(booking)) redirect(`/reschedule/${token}`);
  if (!(await withinLimit(booking.inviteeEmail))) return { ok: false, error: "booking.error.tooMany" };

  const start = new Date(typeof form.start === "string" ? form.start : Number.NaN);
  const startIso = Number.isNaN(start.getTime()) ? null : start.toISOString();
  // Fresh free times, without the busy cache; the chosen start must be one of them.
  const offer = await loadRescheduleOffer(booking, { fresh: true });
  const taken = (): RescheduleResult => ({ ok: false, error: "booking.error.taken", slots: offer.slots.filter((s) => s.start !== startIso) });
  const slot = offer.slots.find((s) => s.start === startIso);
  const availability = offer.availability;
  if (!slot || availability.state !== "ok") return taken();
  const end = new Date(slot.end);

  // The day of the new start in the host's zone, for the daily maximum.
  const day = zonedDay(start, availability.timeZone);
  const dayFrom = dayStart(day, availability.timeZone);
  const dayTo = dayStart(addDays(day, 1), availability.timeZone);
  if (!dayFrom || !dayTo) return taken();

  const db = createAdminSupabase();
  const { data: hold, error: holdError } = await db.rpc("hold_slot", {
    p_host_id: booking.hostId,
    p_starts_at: slot.start,
    p_ends_at: slot.end,
    p_buffer_minutes: availability.input.bufferMinutes,
    p_max_per_day: availability.input.maxBookingsPerDay,
    p_day_from: dayFrom.toISOString(),
    p_day_to: dayTo.toISOString(),
    p_except_booking: booking.bookingId,
  });
  if (holdError || !hold) return taken();
  const release = () => db.rpc("release_hold", { p_hold_id: hold }).then(() => undefined, () => undefined);
  const notMoved = async (): Promise<RescheduleResult> => {
    await release();
    return { ok: false, error: "change.error.notMoved" };
  };

  const access = booking.googleEventId ? await googleAccess(booking.hostId) : null;
  if (!booking.googleEventId || !access?.ok) return notMoved();
  if (!(await takeLease(booking.bookingId))) return notMoved();

  const calendar = availability.primaryCalendarId;
  try {
    await moveEvent(access.token, calendar, booking.googleEventId, { start, end, timeZone: availability.timeZone });
  } catch (cause) {
    console.error("booking: event move", cause);
    await dropLease(booking.bookingId);
    return notMoved();
  }

  const { error } = await db.rpc("reschedule_booking", {
    p_booking_id: booking.bookingId,
    p_hold_id: hold,
    p_starts_at: slot.start,
    p_ends_at: slot.end,
    p_invitee_timezone: safeTimeZone(form.timeZone, getConfig().timeZone),
  });
  if (error) {
    // Nothing was saved: move the event back. The invitee was told about the move, so they hear about this one too.
    await moveEvent(access.token, calendar, booking.googleEventId, {
      start: new Date(booking.startsAt),
      end: new Date(booking.endsAt),
      timeZone: availability.timeZone,
    }).catch((cause) => console.error("booking: event move back", cause));
    await dropLease(booking.bookingId);
    await release();
    // P0002 means the booking is no longer open or the hold expired; only a fresh read can tell which.
    if (!isOpen(await loadConfirmation(token))) redirect(`/reschedule/${token}`);
    if (error.code === "P0002") return taken();
    console.error("booking: reschedule_booking", error);
    return { ok: false, error: "change.error.notMoved" };
  }

  await dropLease(booking.bookingId);
  updateTag(busyCacheTag(booking.hostId));
  // M8 seams: re-plan the booking's jobs and send the change mail here. M9 delivers the outbox row already written.
  redirect(`/confirmed/${token}`);
}

// A plain form post, so it works without JavaScript. Always redirects back to the cancel page: the closed view on
// success (also for a second click), else the form with an error.
export async function cancelBooking(token: string, form: FormData): Promise<void> {
  const back = `/cancel/${token}`;
  const booking = await loadConfirmation(token);
  if (!isOpen(booking)) redirect(back);
  if (!(await withinLimit(booking.inviteeEmail))) redirect(`${back}?error=tooMany`);

  // Database first: if this fails, the invitee must not get a cancellation from Google for a booking that still stands.
  const { error } = await createAdminSupabase().rpc("cancel_booking", {
    p_booking_id: booking.bookingId,
    p_cancelled_by: "invitee",
    p_reason: cancelReason(form.get("reason")),
  });
  if (error && error.code !== "P0002") {
    console.error("booking: cancel_booking", error);
    redirect(`${back}?error=failed`);
  }
  if (!error) {
    // The cancellation counts even if Google fails; the event is left behind then (logged).
    await removeBookingEvent(booking.hostId, booking.googleEventId);
    updateTag(busyCacheTag(booking.hostId));
    // M8 seams: the cancellation mail. M9 delivers the outbox row already written.
  }
  redirect(back);
}
