import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { rescheduleBooking } from "@/lib/booking/change";
import { loadConfirmation, loadRescheduleOffer } from "@/lib/booking/data";
import { getConfig } from "@/lib/config";
import { bookingChange } from "@/lib/core/change";
import { t } from "@/lib/i18n";
import { BookingFacts, ChangeClosed } from "../../_booking/facts";
import { Frame } from "../../_booking/frame";
import styles from "../../_booking/booking.module.css";
import { Reschedule } from "./reschedule";

// Pick a new time with the same host. A wrong token gets the plain 404 page; a cancelled or started booking the closed
// view. Only start/end times go to the browser; the action derives the booking from the token again.

export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const { locale, brand } = getConfig();
  return { title: `${t(locale, "reschedule.title")} – ${brand.name}` };
}

export default async function ReschedulePage({ params }: PageProps<"/reschedule/[token]">) {
  await connection();
  const { token } = await params;
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
  const { locale, timeZone } = getConfig();
  const { slots } = await loadRescheduleOffer(booking);
  return (
    <Frame>
      <div className={styles.layout}>
        <section className={styles.intro}>
          <h1>{t(locale, "reschedule.heading")}</h1>
          <BookingFacts booking={booking} />
        </section>
        <Reschedule
          action={rescheduleBooking.bind(null, token)}
          cancelHref={`/cancel/${token}`}
          locale={locale}
          defaultTimeZone={booking.timeZone || timeZone}
          now={new Date().toISOString()}
          slots={slots}
        />
      </div>
    </Frame>
  );
}
