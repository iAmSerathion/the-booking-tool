import { currentProfile } from "@/lib/auth/profile";

// shortcut: placeholder until the account settings (calendar, availability, rules) land later in M3.
export default async function SettingsPage() {
  const me = await currentProfile();
  return (
    <>
      <h1>Settings</h1>
      <p>Signed in as {me.email}</p>
    </>
  );
}
