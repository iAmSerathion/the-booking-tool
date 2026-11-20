import type { Metadata } from "next";
import { readBrandName, readLocale } from "@/lib/config";

export function generateMetadata(): Metadata {
  return { title: readBrandName(), robots: { index: false, follow: false } };
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang={readLocale()}>
      <body>{children}</body>
    </html>
  );
}
