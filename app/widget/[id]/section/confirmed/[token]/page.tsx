import { connection } from "next/server";
import { WidgetConfirmation } from "../../../../../_booking/widget-confirmation";
import { WidgetStep } from "../../../../../_booking/widget-step";
import { widgetMetadata } from "../../../metadata";

export const generateMetadata = widgetMetadata;

export default async function WidgetSectionConfirmedPage({ params, searchParams }: PageProps<"/widget/[id]/section/confirmed/[token]">) {
  await connection();
  const [{ token }, { new: fresh }] = await Promise.all([params, searchParams]);
  // Straight after booking the host page learns "booked" once; a confirmation opened later is just another step.
  return (
    <>
      <WidgetStep step={fresh === "1" ? "booked" : "confirmed"} token={token} />
      <WidgetConfirmation view="section" token={token} fresh={fresh === "1"} />
    </>
  );
}
