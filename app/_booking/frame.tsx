import type { ReactNode } from "react";
import { getConfig } from "@/lib/config";
import type { WidgetView } from "@/lib/core/widget";
import { t } from "@/lib/i18n";
import styles from "./booking.module.css";

// The public pages' frame: brand from the instance config, privacy and imprint links when they are set. Inside a widget
// (embed) the frame is as tall as its content, so the host page can size the iframe: the window keeps a slim brand
// header, the section shows neither header nor footer.
export function Frame({ children, embed }: { children: ReactNode; embed?: WidgetView }) {
  const { brand, locale } = getConfig();
  return (
    <div className={embed ? `${styles.frame} ${styles.embedded}` : styles.frame}>
      {embed !== "section" && (
        <header className={styles.header}>
          {brand.logoUrl && (
            // An arbitrary https URL from the config; next/image would need it in remotePatterns at build time.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.logoUrl} alt="" height={32} className={styles.logo} />
          )}
          <span className={styles.brand}>{brand.name}</span>
        </header>
      )}
      <main className={styles.main}>{children}</main>
      {!embed && (brand.privacyUrl || brand.imprintUrl) && (
        <footer className={styles.footer}>
          {brand.privacyUrl && <a href={brand.privacyUrl}>{t(locale, "frame.privacy")}</a>}
          {brand.imprintUrl && <a href={brand.imprintUrl}>{t(locale, "frame.imprint")}</a>}
        </footer>
      )}
    </div>
  );
}
