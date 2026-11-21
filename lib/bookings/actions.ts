"use server";

import { refresh, updateTag } from "next/cache";
import { signedIn } from "@/lib/auth/member";
import { busyCacheTag } from "@/lib/availability/data";
import { removeBookingEvent } from "@/lib/booking/google";
import { cancelReason } from "@/lib/core/change";
import type { ActionState } from "@/lib/settings/actions";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failed = (error: string): ActionState => ({ error, saved: false });

// A host (or an admin) cancels a booking. Database first: cancel_booking_as_host checks the right under the booking lock
// and writes the outbox row; only then is the Google event removed, with the BOOKING host's connection, so a failed
// cancel never leaves a booked row whose guest already got Google's cancellation.
export async function cancelBookingAsHost(_state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await signedIn();
  const id = form.get("booking_id");
  if (typeof id !== "string" || !uuidPattern.test(id)) return failed("Unknown booking.");
  // Visibility through RLS: a member cannot even read another host's booking.
  const { data: booking, error: readError } = await supabase.from("bookings").select("host_id, google_event_id").eq("id", id).maybeSingle();
  if (readError) return failed("Cancelling failed. Please try again.");
  if (!booking) return failed("Unknown booking.");

  const { error } = await supabase.rpc("cancel_booking_as_host", { p_booking_id: id, p_reason: cancelReason(form.get("reason")) });
  if (error) {
    if (error.code === "42501") return failed("You cannot cancel this booking.");
    if (error.code === "P0002") return failed("This booking can no longer be cancelled.");
    console.error("bookings: host cancel", error);
    return failed("Cancelling failed. Please try again.");
  }
  updateTag(busyCacheTag(booking.host_id));
  refresh();
  if (!(await removeBookingEvent(booking.host_id, booking.google_event_id)))
    return failed("The booking is cancelled, but its Google Calendar event could not be removed.");
  return { error: null, saved: true };
}
