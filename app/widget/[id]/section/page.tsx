import { connection } from "next/server";
import { BookingPage } from "../../../_booking/booking-page";
import { WidgetStep } from "../../../_booking/widget-step";
import { widgetMetadata } from "../metadata";

// Widget, section mode: the booking inline in the host page, without header or footer.
export const generateMetadata = widgetMetadata;

export default async function WidgetSectionPage({ params }: PageProps<"/widget/[id]/section">) {
  await connection();
  const { id } = await params;
  return (
    <>
      <WidgetStep step="booking" token={null} />
      <BookingPage channel={{ kind: "widget", id, view: "section" }} />
    </>
  );
}
