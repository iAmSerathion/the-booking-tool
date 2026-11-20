import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { loadConfirmation } from "@/lib/booking/data";
import { getConfig } from "@/lib/config";
import { slotLong, timeZoneLabel } from "@/lib/core/booking";
import { t } from "@/lib/i18n";
import { Frame } from "../../_booking/frame";
import styles from "../../_booking/booking.module.css";

// The invitee's confirmation behind the token from the booking redirect (later also from mails). A wrong token gets the
// plain 404 page, so it reveals nothing. Only the token's hash is looked up.

export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const { locale, brand } = getConfig();
  return { title: `${t(locale, "confirmed.title")} – ${brand.name}` };
}

export default async function ConfirmedPage({ params, searchParams }: PageProps<"/confirmed/[token]">) {
  await connection();
  const [{ token }, { new: fresh }] = await Promise.all([params, searchParams]);
  const booking = await loadConfirmation(token);
  if (!booking) notFound();
  const { locale } = getConfig();
  const start = new Date(booking.startsAt);
  const cancelled = booking.state === "cancelled";

  return (
    <Frame>
      <section className={styles.confirm}>
        <h1>{t(locale, cancelled ? "confirmed.cancelled" : "confirmed.heading")}</h1>
        {!cancelled && fresh === "1" && <p>{t(locale, "confirmed.invitationSent")}</p>}
        <dl className={styles.facts}>
          <dt>{t(locale, "confirmed.what")}</dt>
          <dd>{booking.eventTitle}</dd>
          <dt>{t(locale, "confirmed.when")}</dt>
          <dd>
            {slotLong(start, new Date(booking.endsAt), booking.timeZone, locale)}
            <br />
            <span className={styles.muted}>{timeZoneLabel(booking.timeZone, start, locale)}</span>
          </dd>
          <dt>{t(locale, "confirmed.with")}</dt>
          <dd>{booking.hostName}</dd>
          {!cancelled && (
            <>
              <dt>{t(locale, "confirmed.where")}</dt>
              <dd>{booking.meetUrl?.startsWith("https://") ? <a href={booking.meetUrl}>{t(locale, "confirmed.meetLink")}</a> : t(locale, "confirmed.invitation")}</dd>
            </>
          )}
        </dl>
        {/* M5: reschedule and cancel links (/reschedule/<token>, /cancel/<token>) go here. */}
      </section>
    </Frame>
  );
}
