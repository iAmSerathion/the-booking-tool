import { connection } from "next/server";
import { BookingPage } from "../../../_booking/booking-page";
import { widgetMetadata } from "../metadata";

// Widget, section mode: the booking inline in the host page, without header or footer.
export const generateMetadata = widgetMetadata;

export default async function WidgetSectionPage({ params }: PageProps<"/widget/[id]/section">) {
  await connection();
  const { id } = await params;
  return <BookingPage channel={{ kind: "widget", id, view: "section" }} />;
}
