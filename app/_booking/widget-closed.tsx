import { getConfig } from "@/lib/config";
import type { WidgetView } from "@/lib/core/widget";
import { t } from "@/lib/i18n";
import styles from "./booking.module.css";
import { Frame } from "./frame";

// One view for a widget that cannot book (unknown, switched off, event type off, no bookable host). Embedded, such a
// widget gets frame-ancestors 'none', so this shows only when the page is opened directly or from the no-JS link.
export function WidgetClosed({ view }: { view: WidgetView }) {
  const { locale } = getConfig();
  return (
    <Frame embed={view}>
      <section className={styles.confirm}>
        <h1>{t(locale, "widget.closed")}</h1>
        <p>{t(locale, "widget.closedBody")}</p>
      </section>
    </Frame>
  );
}
