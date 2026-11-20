import type { SupabaseClient, User } from "@supabase/supabase-js";
import { decideAccess } from "@/lib/core/access";

export type AdmitRules = { allowedDomains: string[]; initialAdminEmail: string | null };

// Applies the access rule to a user right after the Google code exchange: "in", "out" (has a profile but may not
// enter) or "stranger" (refused, no profile). Needs the service-role client: RLS hides an inactive profile even from
// its owner, so the user's own client would mistake "deactivated" for "new".
export async function admitUser(admin: SupabaseClient, user: User, rules: AdmitRules): Promise<"in" | "out" | "stranger"> {
  const google = user.identities?.find((identity) => identity.provider === "google");
  const email = user.email?.toLowerCase();

  const [profile, admins] = await Promise.all([
    admin.from("profiles").select("active").eq("id", user.id).maybeSingle(),
    admin.from("profiles").select("id", { count: "exact", head: true }).eq("is_admin", true).eq("active", true),
  ]);
  if (profile.error) throw profile.error;
  if (admins.error) throw admins.error;

  if (google && email) {
    const access = decideAccess({
      email,
      emailVerified: google.identity_data?.email_verified === true,
      hostedDomain: (google.identity_data?.custom_claims?.hd as string | undefined)?.toLowerCase() ?? null,
      profile: profile.data,
      ...rules,
      hasActiveAdmin: (admins.count ?? 0) > 0,
    });
    if (access === "ok") return "in";
    if (access !== "refuse") {
      // The database re-checks "no active admin yet" under a lock; a concurrent first admin makes this fail.
      const { error } = await admin.rpc("admit_profile", { p_id: user.id, p_as_admin: access === "create-admin" });
      if (!error) return "in";
      // 42501 = a first admin exists already, 23505 = the profile exists. Anything else is a failure, not a refusal.
      if (error.code !== "42501" && error.code !== "23505") throw error;
    }
  }
  return profile.data ? "out" : "stranger";
}
