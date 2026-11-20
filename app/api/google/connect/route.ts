import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { createSupabase } from "@/lib/db/server";
import { consentUrl, newState, stateCookie, stateCookieOptions } from "@/lib/google/oauth";

// "Connect Google Calendar": off to Google's consent screen, with a state cookie bound to this member.
export async function GET() {
  const config = getConfig();
  const to = (path: string) => NextResponse.redirect(new URL(path, config.appUrl));

  const supabase = await createSupabase();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) return to("/login");
  // RLS hides inactive profiles, so only active members get a row.
  const { data: profile } = await supabase.from("profiles").select("email").eq("id", userId).maybeSingle();
  if (!profile) return to("/login?error=no-access");

  const { state, cookie } = newState(userId);
  const response = NextResponse.redirect(consentUrl({ state, email: profile.email }));
  response.cookies.set(stateCookie, cookie, stateCookieOptions());
  return response;
}
