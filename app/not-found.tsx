import { connection } from "next/server";
import { getConfig } from "@/lib/config";
import { t } from "@/lib/i18n";
import { Frame } from "./_booking/frame";

// Unknown pages and wrong confirmation links, in the instance's language and brand. The config is read at request time.
export default async function NotFound() {
  await connection();
  const { locale } = getConfig();
  return (
    <Frame>
      <h1>{t(locale, "notFound.title")}</h1>
      <p>{t(locale, "notFound.body")}</p>
    </Frame>
  );
}
