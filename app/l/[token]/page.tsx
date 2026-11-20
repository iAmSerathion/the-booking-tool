import type { Metadata } from "next";
import { connection } from "next/server";
import { getConfig } from "@/lib/config";
import { t } from "@/lib/i18n";
import { BookingPage } from "../../_booking/booking-page";

// A booking link: fixed host and event type, prefilled form. Everything comes from the token on the server.
export async function generateMetadata(): Promise<Metadata> {
  const { locale, brand } = getConfig();
  // Never index links meant for one invitee.
  return { title: `${t(locale, "link.title")} – ${brand.name}`, robots: { index: false, follow: false } };
}

export default async function LinkPage({ params }: PageProps<"/l/[token]">) {
  await connection();
  const { token } = await params;
  return <BookingPage channel={{ kind: "link", token }} />;
}
