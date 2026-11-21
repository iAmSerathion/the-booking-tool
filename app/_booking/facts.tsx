import type { Confirmation } from "@/lib/booking/data";
import { getConfig } from "@/lib/config";
import { slotLong, timeZoneLabel } from "@/lib/core/booking";
import { t } from "@/lib/i18n";
import styles from "./booking.module.css";

// Inside a widget frame, links leave it: the change pages cannot be framed, and Meet should not open in a small frame.
const newTabProps = { target: "_blank", rel: "noopener" } as const;

// What, when and with whom, in the booking's zone; the confirmation also shows where.
export function BookingFacts({ booking, where = false, newTab = false }: { booking: Confirmation; where?: boolean; newTab?: boolean }) {
  const { locale } = getConfig();
  const start = new Date(booking.startsAt);
  return (
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
      {where && (
        <>
          <dt>{t(locale, "confirmed.where")}</dt>
          <dd>
            {booking.meetUrl?.startsWith("https://") ? (
              <a href={booking.meetUrl} {...(newTab ? newTabProps : {})}>
                {t(locale, "confirmed.meetLink")}
              </a>
            ) : (
              t(locale, "confirmed.invitation")
            )}
          </dd>
        </>
      )}
    </dl>
  );
}

// The links a booking offers in its state: reschedule and cancel while it is open, book again once cancelled. "Book a
// new time" is a plain <a>: every visit of that route creates a link, so it must never be prefetched.
export function ChangeLinks({ token, change, newTab = false }: { token: string; change: "open" | "cancelled" | "past"; newTab?: boolean }) {
  const { locale } = getConfig();
  if (change === "past") return null;
  const tab = newTab ? newTabProps : {};
  return (
    <p className={styles.actions}>
      {change === "open" ? (
        <>
          <a href={`/reschedule/${token}`} {...tab}>
            {t(locale, "change.reschedule")}
          </a>
          <a href={`/cancel/${token}`} {...tab}>
            {t(locale, "change.cancel")}
          </a>
        </>
      ) : (
        <a href={`/cancel/${token}/new`} {...tab}>
          {t(locale, "change.rebook")}
        </a>
      )}
    </p>
  );
}

// Shown instead of the reschedule or cancel form once the booking is cancelled or has started.
export function ChangeClosed({ booking, token, change }: { booking: Confirmation; token: string; change: "cancelled" | "past" }) {
  const { locale } = getConfig();
  return (
    <section className={styles.confirm}>
      <h1>{t(locale, change === "cancelled" ? "confirmed.cancelled" : "change.past")}</h1>
      <p>{t(locale, change === "cancelled" ? "change.cancelledBody" : "change.pastBody")}</p>
      <BookingFacts booking={booking} />
      <ChangeLinks token={token} change={change} />
    </section>
  );
}
