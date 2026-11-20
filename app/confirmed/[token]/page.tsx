import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { loadConfirmation } from "@/lib/booking/data";
import { getConfig } from "@/lib/config";
import { bookingChange } from "@/lib/core/change";
import { t } from "@/lib/i18n";
import { BookingFacts, ChangeLinks } from "../../_booking/facts";
import { Frame } from "../../_booking/frame";
import styles from "../../_booking/booking.module.css";

// The invitee's confirmation behind the token from the booking redirect (later also from mails), with the links to
// reschedule or cancel. A wrong token gets the plain 404 page, so it reveals nothing. Only the token's hash is looked up.

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
  const cancelled = booking.state === "cancelled";

  return (
    <Frame>
      <section className={styles.confirm}>
        <h1>{t(locale, cancelled ? "confirmed.cancelled" : "confirmed.heading")}</h1>
        {!cancelled && fresh === "1" && <p>{t(locale, "confirmed.invitationSent")}</p>}
        <BookingFacts booking={booking} where={!cancelled} />
        <ChangeLinks token={token} change={bookingChange(booking, new Date())} />
      </section>
    </Frame>
  );
}
