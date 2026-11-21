import { connection } from "next/server";
import { WidgetConfirmation } from "../../../../../_booking/widget-confirmation";
import { widgetMetadata } from "../../../metadata";

export const generateMetadata = widgetMetadata;

export default async function WidgetSectionConfirmedPage({ params, searchParams }: PageProps<"/widget/[id]/section/confirmed/[token]">) {
  await connection();
  const [{ token }, { new: fresh }] = await Promise.all([params, searchParams]);
  return <WidgetConfirmation view="section" token={token} fresh={fresh === "1"} />;
}
