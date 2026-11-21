import { notFound } from "next/navigation";
import { connection } from "next/server";
import { BookingPage } from "./_booking/booking-page";

// The website default: the member chosen in settings (website_mode "person") or round robin over all bookable members.
// ?type=<slug> books another active event type than the default one.
export default async function Home({ searchParams }: PageProps<"/">) {
  await connection();
  const { type } = await searchParams;
  if (Array.isArray(type)) notFound();
  return <BookingPage channel={{ kind: "page", eventType: type }} />;
}
