import { notFound } from "next/navigation";
import { connection } from "next/server";
import { BookingPage } from "../_booking/booking-page";

// A member's own booking page. Unknown, malformed or unbookable slugs get the 404 page (loadBookingPage returns null).
// Static routes (app, login, confirmed, ...) win over this one; profiles_slug_check keeps members off those names.
// ?type=<slug> books another active event type than the default one.
export default async function MemberPage({ params, searchParams }: PageProps<"/[slug]">) {
  await connection();
  const [{ slug }, { type }] = await Promise.all([params, searchParams]);
  if (Array.isArray(type)) notFound();
  return <BookingPage channel={{ kind: "person", slug, eventType: type }} />;
}
