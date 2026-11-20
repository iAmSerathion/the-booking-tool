import { readBrandName, readLocale } from "@/lib/config";
import { t } from "@/lib/i18n";

export default function Home() {
  const locale = readLocale();
  return (
    <main>
      <h1>{t(locale, "home.title", { brand: readBrandName() })}</h1>
      <p>{t(locale, "home.setup")}</p>
    </main>
  );
}
