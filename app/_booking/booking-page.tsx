import { notFound } from "next/navigation";
import { bookSlot } from "@/lib/booking/actions";
import { type ChannelRef, loadBookingPage } from "@/lib/booking/data";
import { getConfig } from "@/lib/config";
import { t } from "@/lib/i18n";
import styles from "./booking.module.css";
import { Booking } from "./booking";
import { Frame } from "./frame";
import { LinkClosed } from "./link-closed";
import { WidgetBooking } from "./widget-booking";
import { WidgetClosed } from "./widget-closed";

// A public booking page: "/" (website default), "/<slug>" (one member), "/l/<token>" (a booking link) or a widget
// "/widget/<id>[/section]". The caller has awaited connection(). A link or widget that cannot be used gets its neutral
// closed view, never a hint why.
// Only titles, names and free start/end times go to the browser; host ids stay here and the action derives them again.
export async function BookingPage({ channel }: { channel: ChannelRef }) {
  const page = await loadBookingPage(channel);
  if (!page) return channel.kind === "link" ? <LinkClosed /> : channel.kind === "widget" ? <WidgetClosed view={channel.view} /> : notFound();
  const { context, slots } = page;
  const config = getConfig();
  const { title, description, durationMinutes, questions } = context.eventType;
  const props = {
    // Bound on the server, so the browser cannot switch the page it books on.
    action: bookSlot.bind(null, channel),
    locale: config.locale,
    defaultTimeZone: config.timeZone,
    privacyUrl: config.brand.privacyUrl,
    now: new Date().toISOString(),
    eventType: { title, description, durationMinutes, questions },
    hostName: context.hosts.length === 1 ? context.hosts[0].name : null,
    meet: context.hosts.length > 0 && context.hosts.every((h) => h.meetAuto),
    slots,
  };
  return channel.kind === "widget" ? (
    // The host page's prefill arrives through the bridge, not from the server.
    <Frame embed={channel.view}>
      <WidgetBooking {...props} />
    </Frame>
  ) : (
    <Frame>
      {context.eventTypes && context.eventTypes.length > 1 && (
        // Plain links: the event type is part of the page's URL, so the action bound above books exactly this one.
        <nav aria-label={t(config.locale, "booking.eventTypes")} className={styles.types}>
          <ul>
            {context.eventTypes.map((type) => (
              <li key={type.slug}>
                <a href={`?type=${type.slug}`} aria-current={type.slug === context.eventType.slug ? "page" : undefined}>
                  {type.title} <span>{t(config.locale, "booking.minutes", { minutes: type.durationMinutes })}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <Booking {...props} prefill={context.prefill} />
    </Frame>
  );
}
