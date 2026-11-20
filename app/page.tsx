import { connection } from "next/server";
import { BookingPage } from "./_booking/booking-page";

// The website default: the member chosen in settings (website_mode "person") or round robin over all bookable members.
export default async function Home() {
  await connection();
  return <BookingPage channel={{ kind: "page" }} />;
}
