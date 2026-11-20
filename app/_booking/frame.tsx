import type { ReactNode } from "react";
import { getConfig } from "@/lib/config";
import { t } from "@/lib/i18n";
import styles from "./booking.module.css";

// The public pages' frame: brand from the instance config, privacy and imprint links when they are set.
export function Frame({ children }: { children: ReactNode }) {
  const { brand, locale } = getConfig();
  return (
    <div className={styles.frame}>
      <header className={styles.header}>
        {brand.logoUrl && (
          // An arbitrary https URL from the config; next/image would need it in remotePatterns at build time.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={brand.logoUrl} alt="" height={32} className={styles.logo} />
        )}
        <span className={styles.brand}>{brand.name}</span>
      </header>
      <main className={styles.main}>{children}</main>
      {(brand.privacyUrl || brand.imprintUrl) && (
        <footer className={styles.footer}>
          {brand.privacyUrl && <a href={brand.privacyUrl}>{t(locale, "frame.privacy")}</a>}
          {brand.imprintUrl && <a href={brand.imprintUrl}>{t(locale, "frame.imprint")}</a>}
        </footer>
      )}
    </div>
  );
}
