"use server";

import { redirect } from "next/navigation";
import { getConfig } from "@/lib/config";
import { createSupabase } from "@/lib/db/server";

// Login asks only for the sign-in scopes; the calendar is a separate consent (/api/google/connect).
export async function signInWithGoogle() {
  const { appUrl, google } = getConfig();
  const supabase = await createSupabase();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${appUrl}/auth/callback`,
      queryParams: { prompt: "select_account", ...(google.hostedDomain ? { hd: google.hostedDomain } : {}) },
    },
  });
  if (error || !data.url) redirect("/login?error=failed");
  redirect(data.url);
}

// This device only; other sessions of the same member stay signed in.
export async function signOut() {
  const supabase = await createSupabase();
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}
