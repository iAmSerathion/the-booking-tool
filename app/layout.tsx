import type { Metadata } from "next";
import { connection } from "next/server";
import { readBrandName, readLocale } from "@/lib/config";

// Brand and locale come from the environment at request time, so one build serves any configuration.
// Reading env is instant, so blocking on it costs nothing.
export const instant = false;

export async function generateMetadata(): Promise<Metadata> {
  await connection();
  return { title: readBrandName(), robots: { index: false, follow: false } };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  await connection();
  return (
    <html lang={readLocale()}>
      <body>{children}</body>
    </html>
  );
}
