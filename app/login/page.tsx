import type { Metadata } from "next";
import { connection } from "next/server";
import { signInWithGoogle } from "@/lib/auth/actions";
import { readBrandName, readLocale } from "@/lib/config";
import { t } from "@/lib/i18n";
import styles from "./login.module.css";

// Renders without a configured instance too; only the sign-in action needs the full config.
const notices = { "no-access": "login.noAccess", failed: "login.failed" } as const;

export async function generateMetadata(): Promise<Metadata> {
  await connection();
  return { title: t(readLocale(), "login.title", { brand: readBrandName() }) };
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  await connection();
  const locale = readLocale();
  const { error } = await searchParams;
  // Only known keys, so the query string cannot put text on the page.
  const notice = typeof error === "string" && Object.hasOwn(notices, error) ? notices[error as keyof typeof notices] : null;
  return (
    <main className={styles.page}>
      <h1>{readBrandName()}</h1>
      <p>{t(locale, "login.intro")}</p>
      {notice && (
        <p role="alert" className={styles.alert}>
          {t(locale, notice)}
        </p>
      )}
      <form action={signInWithGoogle}>
        <button type="submit" className={styles.button}>
          {t(locale, "login.google")}
        </button>
      </form>
    </main>
  );
}
