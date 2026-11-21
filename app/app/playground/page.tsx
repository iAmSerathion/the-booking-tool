import { notFound } from "next/navigation";
import { currentProfile } from "@/lib/auth/profile";
import { getConfig } from "@/lib/config";
import { listWidgets } from "@/lib/widget/data";
import { playgroundAllowed } from "./allowed";
import { Playground } from "./playground";

// Try a widget the way a host website embeds it: /widget.js from this instance, a window button and a section with a
// prefill. It works because every active widget allows the instance's own origin (widgetEmbedOrigins).
export default async function PlaygroundPage() {
  const me = await currentProfile();
  if (!playgroundAllowed(me.is_admin)) notFound();
  const widgets = (await listWidgets()).filter((w) => w.active).map(({ id, name }) => ({ id, name }));
  return (
    <>
      <h1>Playground</h1>
      <p>Try an active widget on this page. Bookings made here are real bookings.</p>
      {widgets.length ? <Playground widgets={widgets} locale={getConfig().locale} /> : <p>There is no active widget.</p>}
    </>
  );
}
