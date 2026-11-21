import { getConfig } from "@/lib/config";
import { t } from "@/lib/i18n";
import styles from "./booking.module.css";
import { Frame } from "./frame";

// One view for every booking link that cannot be used (unknown, used, expired, revoked, host or event type gone), so the
// page never tells a caller which of these it is.
export function LinkClosed() {
  const { locale } = getConfig();
  return (
    <Frame>
      <section className={styles.confirm}>
        <h1>{t(locale, "link.closed")}</h1>
        <p>{t(locale, "link.closedBody")}</p>
      </section>
    </Frame>
  );
}
