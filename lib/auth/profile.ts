import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { createSupabase } from "@/lib/db/server";

// The signed-in member, read once per request. proxy.ts already guards /app; this is the second line for pages.
export const currentProfile = cache(async () => {
  await connection();
  const supabase = await createSupabase();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) redirect("/login");
  const { data: profile, error } = await supabase.from("profiles").select("id, name, email, is_admin").eq("id", userId).maybeSingle();
  if (error) throw error;
  if (!profile) redirect("/login?error=no-access");
  return profile;
});
