import Link from "next/link";
import { signOut } from "@/lib/auth/actions";
import { currentProfile } from "@/lib/auth/profile";
import { readBrandName } from "@/lib/config";
import styles from "./shell.module.css";

// Admin shell. English only for now (plan section 3); customer-facing pages use lib/i18n.
export default async function AppLayout({ children }: LayoutProps<"/app">) {
  const me = await currentProfile();
  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <strong>{readBrandName()}</strong>
        <nav aria-label="Main">
          <Link href="/app/links">Links</Link>
          <Link href="/app/settings">Settings</Link>
        </nav>
        <span className={styles.me}>
          {me.name} · {me.is_admin ? "Admin" : "Member"}
        </span>
        <form action={signOut}>
          <button type="submit">Sign out</button>
        </form>
      </header>
      <main>{children}</main>
    </div>
  );
}
