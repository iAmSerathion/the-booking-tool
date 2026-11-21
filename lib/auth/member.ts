import { createSupabase } from "@/lib/db/server";

// The signed-in, active member for admin server actions: their RLS client and id. A plain module, not "use server":
// every export of a server action file is a public endpoint. No id ever comes from a form; RLS applies to every write.
export async function signedIn() {
  const supabase = await createSupabase();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) throw new Error("Not signed in");
  // RLS hides inactive profiles: deactivated members cannot change anything.
  const { data: profile } = await supabase.from("profiles").select("id, is_admin").eq("id", userId).maybeSingle();
  if (!profile) throw new Error("No access");
  return { supabase, userId, isAdmin: profile.is_admin as boolean };
}
