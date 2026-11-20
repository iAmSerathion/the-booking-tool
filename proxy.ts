import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";

// Runs before every /app page: refreshes the Supabase session cookies (Server Components cannot) and sends visitors
// without a session, or without an active profile, to /login. Security headers still come from next.config.ts.
export async function proxy(request: NextRequest) {
  let config;
  try {
    config = getConfig();
  } catch {
    // Not configured yet: a relative redirect, since without APP_URL there is no trusted origin.
    return new NextResponse(null, { status: 307, headers: { Location: "/login" } });
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(config.supabase.url, config.supabase.anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(list, headers) {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
      },
    },
  });

  // Links come from APP_URL, never from the Host header. Refreshed or cleared cookies go along with the redirect.
  const redirect = (path: string) => {
    const target = NextResponse.redirect(new URL(path, config.appUrl));
    for (const cookie of response.cookies.getAll()) target.cookies.set(cookie);
    return target;
  };

  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) return redirect("/login");

  // RLS shows profiles only to active members, so a deactivated member gets no row, just like a stranger.
  const { data: profile, error } = await supabase.from("profiles").select("id").eq("id", userId).maybeSingle();
  if (error) throw error;
  if (!profile) {
    await supabase.auth.signOut({ scope: "local" });
    return redirect("/login?error=no-access");
  }
  return response;
}

export const config = { matcher: ["/app", "/app/:path*"] };
