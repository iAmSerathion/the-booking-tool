import type { Metadata } from "next";
import { connection } from "next/server";
import { getConfig } from "@/lib/config";
import { t } from "@/lib/i18n";

// Shared by the widget pages: a neutral title with the instance brand.
export async function widgetMetadata(): Promise<Metadata> {
  await connection();
  const { locale, brand } = getConfig();
  return { title: `${t(locale, "widget.title")} – ${brand.name}` };
}
