import { redirect } from "next/navigation";
import { connection } from "next/server";
import { loadConfirmation } from "@/lib/booking/data";
import { withinBookingLimit } from "@/lib/booking/limit";
import { hashToken, newToken } from "@/lib/booking/token";
import { createAdminSupabase } from "@/lib/db/admin";

// "Book a new time" after a cancellation: a fresh single-use booking link to the same host and event type, prefilled
// with the invitee (rebook_link), then on to it. A GET because mails (M8) link here, so every hit creates a link: only
// for cancelled bookings, rate limited, and the pages link here with a plain <a> (never prefetched).
export async function GET(_request: Request, { params }: RouteContext<"/cancel/[token]/new">) {
  await connection();
  const { token } = await params;
  const booking = await loadConfirmation(token);
  // An unknown token ends on the confirmation page's 404 like any other wrong link (notFound() in a route handler has no
  // page). Encoded, so the token stays one path segment.
  const back = `/confirmed/${encodeURIComponent(token)}`;
  if (!booking) redirect(back);
  if (booking.state !== "cancelled" || !(await withinBookingLimit(booking.bookingId))) redirect(back);

  const link = newToken();
  const { data, error } = await createAdminSupabase().rpc("rebook_link", { p_booking_id: booking.bookingId, p_token_hash: hashToken(link) });
  if (error) console.error("booking: rebook_link", error);
  // False: the host can no longer take bookings; the confirmation page still shows the cancellation.
  if (error || data !== true) redirect(back);
  redirect(`/l/${link}`);
}
