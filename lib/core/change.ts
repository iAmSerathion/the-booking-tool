import { cleanMultiline } from "./questions";

// Whether an invitee may still reschedule or cancel a booking through its token links. Pure.
//
// No cutoff before the start: a change is open up to the start minute, as cancel_booking and reschedule_booking check in
// the database. The slot offer still applies the host's minimum notice to the new time.

export type BookingChange = "open" | "cancelled" | "past";

export function bookingChange(booking: { state: "booked" | "cancelled"; startsAt: string }, now: Date): BookingChange {
  if (booking.state === "cancelled") return "cancelled";
  return Date.parse(booking.startsAt) <= now.getTime() ? "past" : "open";
}

export const cancelReasonMaxLength = 2000;

// The optional reason from the cancel form; empty becomes null.
export function cancelReason(value: unknown): string | null {
  return cleanMultiline(value, cancelReasonMaxLength) || null;
}
