import { connection, type NextRequest, NextResponse } from "next/server";
import { admitUser } from "@/lib/auth/admit";
import { getConfig } from "@/lib/config";
import { createAdminSupabase } from "@/lib/db/admin";
import { createSupabase } from "@/lib/db/server";

// Supabase sends the browser here after Google sign-in. Every redirect goes to an APP_URL path, never to a query value.
export async function GET(request: NextRequest) {
  await connection();
  const config = getConfig();
  const to = (path: string) => NextResponse.redirect(new URL(path, config.appUrl));

  const code = request.nextUrl.searchParams.get("code");
  if (!code) return to("/login?error=failed");
  const supabase = await createSupabase();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) return to("/login?error=failed");

  // Only the user GoTrue returns for this session counts: its email and identities are verified by Supabase and Google.
  const rules = { allowedDomains: config.google.allowedDomains, initialAdminEmail: config.initialAdminEmail };
  const admin = createAdminSupabase();
  const result = await admitUser(admin, data.user, rules).catch(() => "failed" as const);
  if (result === "in") return to("/app");

  await supabase.auth.signOut({ scope: "local" });
  // Google sign-in creates the auth user before this check; remove refused strangers so none lingers to block an invite.
  if (result === "stranger") await admin.auth.admin.deleteUser(data.user.id);
  return to(result === "failed" ? "/login?error=failed" : "/login?error=no-access");
}
