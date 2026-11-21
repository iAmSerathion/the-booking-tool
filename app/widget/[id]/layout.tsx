import { connection } from "next/server";
import { getConfig } from "@/lib/config";
import { widgetEmbedOrigins } from "@/lib/core/widget";
import { loadWidget } from "@/lib/widget/data";
import { WidgetBridge } from "./bridge";

// Every widget page: the bridge to the host page, with the same origins the proxy puts into frame-ancestors. It stays
// mounted from the booking to its confirmation. A widget that cannot be embedded gets no bridge.
export default async function WidgetLayout({ children, params }: LayoutProps<"/widget/[id]">) {
  await connection();
  const { id } = await params;
  const { embedAllowedOrigins, appUrl } = getConfig();
  const widget = await loadWidget(id).catch((cause) => {
    console.error("widget: layout", cause);
    return null;
  });
  const allowed = widgetEmbedOrigins(widget, embedAllowedOrigins, appUrl);
  return (
    <>
      {allowed.length > 0 && <WidgetBridge allowed={allowed} />}
      {children}
    </>
  );
}
