import { connection } from "next/server";
import { BookingPage } from "../_booking/booking-page";

// A member's own booking page. Unknown, malformed or unbookable slugs get the 404 page (loadBookingPage returns null).
// Static routes (app, login, confirmed, ...) win over this one; profiles_slug_check keeps members off those names.
export default async function MemberPage({ params }: PageProps<"/[slug]">) {
  await connection();
  const { slug } = await params;
  return <BookingPage channel={{ kind: "person", slug }} />;
}
