import { connection } from "next/server";
import { BookingPage } from "../../_booking/booking-page";
import { widgetMetadata } from "./metadata";

// Widget, window mode: the page widget.js opens in its dialog, and the no-JS link target. The proxy sets frame-ancestors.
export const generateMetadata = widgetMetadata;

export default async function WidgetWindowPage({ params }: PageProps<"/widget/[id]">) {
  await connection();
  const { id } = await params;
  return <BookingPage channel={{ kind: "widget", id, view: "window" }} />;
}
