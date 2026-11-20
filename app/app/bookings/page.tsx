import { Fragment } from "react";
import { currentProfile } from "@/lib/auth/profile";
import { cancelBookingAsHost } from "@/lib/bookings/actions";
import { loadUpcomingBookings } from "@/lib/bookings/data";
import { slotLong, timeZoneLabel } from "@/lib/core/booking";
import { ActionForm } from "../settings/action-form";
import styles from "../settings/settings.module.css";

const show = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

// Upcoming bookings with what the invitee entered. Members see their own; admins all, with the host.
export default async function BookingsPage() {
  const me = await currentProfile();
  const bookings = await loadUpcomingBookings();
  return (
    <>
      <h1>Bookings</h1>
      <p>Times are shown in {timeZoneLabel(me.timezone, new Date(), "en")}.</p>
      {bookings.length === 0 && <p>No upcoming bookings.</p>}
      <ul className={styles.cards}>
        {bookings.map((b) => {
          const when = slotLong(new Date(b.starts_at), new Date(b.ends_at), me.timezone, "en");
          const meta = Object.entries(b.metadata ?? {}).sort(([x], [y]) => x.localeCompare(y));
          return (
            <li key={b.id} className={styles.card} aria-label={`${b.invitee_name}, ${when}`}>
              <dl className={styles.pairs}>
                <dt>When</dt>
                <dd>{when}</dd>
                <dt>Event type</dt>
                <dd>{b.eventType}</dd>
                {me.is_admin && (
                  <>
                    <dt>Host</dt>
                    <dd>{b.host}</dd>
                  </>
                )}
                <dt>Invitee</dt>
                <dd>
                  {b.invitee_name} · <a href={`mailto:${b.invitee_email}`}>{b.invitee_email}</a>
                </dd>
                {b.invitee_company && (
                  <>
                    <dt>Company</dt>
                    <dd>{b.invitee_company}</dd>
                  </>
                )}
                {b.invitee_phone && (
                  <>
                    <dt>Phone</dt>
                    <dd>{b.invitee_phone}</dd>
                  </>
                )}
                {b.topic && (
                  <>
                    <dt>Topic</dt>
                    <dd>{b.topic}</dd>
                  </>
                )}
                {(b.answers ?? []).map((a, i) => (
                  <Fragment key={i}>
                    <dt>{a.question}</dt>
                    <dd>{Array.isArray(a.answer) ? a.answer.join(", ") : a.answer}</dd>
                  </Fragment>
                ))}
                {meta.length > 0 && (
                  <>
                    <dt>Metadata</dt>
                    <dd>{meta.map(([k, v]) => `${k}=${show(v)}`).join(", ")}</dd>
                  </>
                )}
              </dl>
              <ActionForm action={cancelBookingAsHost} submit={`Cancel booking with ${b.invitee_name}`}>
                <input type="hidden" name="booking_id" value={b.id} />
                <label className={styles.field}>
                  Reason (optional)
                  <input name="reason" maxLength={2000} />
                </label>
              </ActionForm>
            </li>
          );
        })}
      </ul>
    </>
  );
}
