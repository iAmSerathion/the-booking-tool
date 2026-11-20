import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { cancelBooking } from "@/lib/booking/change";
import { loadConfirmation } from "@/lib/booking/data";
import { getConfig } from "@/lib/config";
import { bookingChange, cancelReasonMaxLength } from "@/lib/core/change";
import { type MessageKey, t } from "@/lib/i18n";
import { BookingFacts, ChangeClosed } from "../../_booking/facts";
import { Frame } from "../../_booking/frame";
import styles from "../../_booking/booking.module.css";

// Cancel with an optional reason: a plain form post, no JavaScript needed. A wrong token gets the plain 404 page; a
// cancelled or started booking the closed view (with "book a new time" once cancelled).

export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const { locale, brand } = getConfig();
  return { title: `${t(locale, "cancel.title")} – ${brand.name}` };
}

// Only these come back from the action; anything else in the query is ignored.
const errors: Record<string, MessageKey> = { tooMany: "booking.error.tooMany", failed: "change.error.notCancelled" };

export default async function CancelPage({ params, searchParams }: PageProps<"/cancel/[token]">) {
  await connection();
  const [{ token }, { error }] = await Promise.all([params, searchParams]);
  const booking = await loadConfirmation(token);
  if (!booking) notFound();
  const change = bookingChange(booking, new Date());
  if (change !== "open") {
    return (
      <Frame>
        <ChangeClosed booking={booking} token={token} change={change} />
      </Frame>
    );
  }
  const { locale } = getConfig();
  const message = typeof error === "string" ? errors[error] : undefined;
  return (
    <Frame>
      <section className={styles.confirm}>
        <h1>{t(locale, "cancel.heading")}</h1>
        <BookingFacts booking={booking} />
        <form action={cancelBooking.bind(null, token)} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="cancel-reason" className={styles.label}>
              {t(locale, "cancel.reason")}
            </label>
            <textarea id="cancel-reason" name="reason" rows={3} maxLength={cancelReasonMaxLength} className={styles.input} />
          </div>
          {message && (
            <p role="alert" className={styles.alert}>
              {t(locale, message)}
            </p>
          )}
          <button type="submit" className={styles.submit}>
            {t(locale, "cancel.submit")}
          </button>
        </form>
        <p className={styles.actions}>
          <a href={`/confirmed/${token}`}>{t(locale, "cancel.keep")}</a>
        </p>
      </section>
    </Frame>
  );
}
