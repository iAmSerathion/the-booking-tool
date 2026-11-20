import { notFound } from "next/navigation";
import { bookSlot } from "@/lib/booking/actions";
import { type ChannelRef, loadBookingPage } from "@/lib/booking/data";
import { getConfig } from "@/lib/config";
import { Booking } from "./booking";
import { Frame } from "./frame";
import { LinkClosed } from "./link-closed";

// A public booking page: "/" (website default), "/<slug>" (one member) or "/l/<token>" (a booking link). The caller has
// awaited connection(). A link that cannot be used gets the neutral closed view, never a hint why.
// Only titles, names and free start/end times go to the browser; host ids stay here and the action derives them again.
export async function BookingPage({ channel }: { channel: ChannelRef }) {
  const page = await loadBookingPage(channel);
  if (!page) return channel.kind === "link" ? <LinkClosed /> : notFound();
  const { context, slots } = page;
  const config = getConfig();
  const { title, description, durationMinutes, questions } = context.eventType;
  return (
    <Frame>
      <Booking
        // Bound on the server, so the browser cannot switch the page it books on.
        action={bookSlot.bind(null, channel)}
        locale={config.locale}
        defaultTimeZone={config.timeZone}
        privacyUrl={config.brand.privacyUrl}
        now={new Date().toISOString()}
        eventType={{ title, description, durationMinutes, questions }}
        hostName={context.hosts.length === 1 ? context.hosts[0].name : null}
        meet={context.hosts.length > 0 && context.hosts.every((h) => h.meetAuto)}
        slots={slots}
        prefill={context.prefill}
      />
    </Frame>
  );
}
