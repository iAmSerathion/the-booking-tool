import { type NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { createAdminSupabase } from "@/lib/db/admin";
import { createSupabase } from "@/lib/db/server";
import { listCalendars } from "@/lib/google/calendar";
import type { GoogleNotice } from "@/lib/google/notices";
import { exchangeCode, idTokenEmail, revokeToken, stateCookie, stateCookieOptions, stateMatches } from "@/lib/google/oauth";
import { grantedScopes, scopesAfterConnect } from "@/lib/google/scopes";

// Google's redirect back: check the state, swap the code for tokens, check the account, keep the refresh token in Vault.
export async function GET(request: NextRequest) {
  const config = getConfig();
  const to = (path: string) => NextResponse.redirect(new URL(path, config.appUrl));
  const back = (notice?: GoogleNotice) => {
    const response = to(notice ? `/app/settings?google=${notice}` : "/app/settings");
    response.cookies.set(stateCookie, "", { ...stateCookieOptions(), maxAge: 0 });
    return response;
  };

  const supabase = await createSupabase();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) return to("/login");
  const { data: profile } = await supabase.from("profiles").select("email").eq("id", userId).maybeSingle();
  if (!profile) return to("/login?error=no-access");

  // State first: otherwise anyone could link a member here and make the page show notices.
  const params = request.nextUrl.searchParams;
  if (!stateMatches(request.cookies.get(stateCookie)?.value, params.get("state"), userId)) return back("error");
  if (params.get("error")) return back("cancelled");
  const code = params.get("code");
  if (!code) return back("error");

  let tokens;
  try {
    tokens = await exchangeCode(code);
  } catch {
    return back("error");
  }
  // Every refusal after the exchange gives the grant back, so nothing is left dangling at Google.
  const refuse = async (notice: GoogleNotice) => {
    await revokeToken(tokens.refresh_token ?? tokens.access_token);
    return back(notice);
  };

  // account_email is required, so the id_token must carry a verified email even when any account is allowed.
  const email = idTokenEmail(tokens.id_token);
  if (!email) return refuse("error");
  if (config.google.requireSameEmail && email !== profile.email.toLowerCase()) return refuse("wrong-account");
  const scopes = scopesAfterConnect(grantedScopes(tokens.scope));
  if (!scopes) return refuse("missing-scopes");
  if (!tokens.refresh_token) return refuse("error");

  let primaryCalendarId = email;
  try {
    primaryCalendarId = (await listCalendars(tokens.access_token)).find((calendar) => calendar.primary)?.id ?? email;
  } catch {
    // The primary calendar's id is the account email at Google; good enough until the next list works.
  }

  const { error } = await createAdminSupabase().rpc("google_connection_save", {
    p_user_id: userId,
    p_account_email: email,
    p_refresh_token: tokens.refresh_token,
    p_scopes: scopes,
    p_primary_calendar_id: primaryCalendarId,
  });
  if (error) return refuse("error");
  // shortcut: no push channel or first calendar sync yet; both hook in here once calendar sync lands (M8).
  return back();
}
