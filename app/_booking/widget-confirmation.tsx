import { notFound } from "next/navigation";
import { loadConfirmation } from "@/lib/booking/data";
import { getConfig } from "@/lib/config";
import { bookingChange } from "@/lib/core/change";
import type { WidgetView } from "@/lib/core/widget";
import { t } from "@/lib/i18n";
import styles from "./booking.module.css";
import { BookingFacts, ChangeLinks } from "./facts";
import { Frame } from "./frame";

// The confirmation inside a widget frame, the same as /confirmed/<token> but framable under the widget's CSP. Its links
// open in a new tab: the change pages send frame-ancestors 'none'. The caller has awaited connection().
export async function WidgetConfirmation({ view, token, fresh }: { view: WidgetView; token: string; fresh: boolean }) {
  const booking = await loadConfirmation(token);
  if (!booking) notFound();
  const { locale } = getConfig();
  const cancelled = booking.state === "cancelled";
  return (
    <Frame embed={view}>
      <section className={styles.confirm}>
        <h1>{t(locale, cancelled ? "confirmed.cancelled" : "confirmed.heading")}</h1>
        {!cancelled && fresh && <p>{t(locale, "confirmed.invitationSent")}</p>}
        <BookingFacts booking={booking} where={!cancelled} newTab />
        <ChangeLinks token={token} change={bookingChange(booking, new Date())} newTab />
      </section>
    </Frame>
  );
}
