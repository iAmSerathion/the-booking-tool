import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { widgetFrameAncestors } from "@/lib/core/widget";
import { loadWidget } from "@/lib/widget/data";

// Runs before every /app page: refreshes the Supabase session cookies (Server Components cannot) and sends visitors
// without a session, or without an active profile, to /login. Security headers still come from next.config.ts.
// Widget pages only get their frame-ancestors here: no session, no cookies, no redirect for anonymous visitors.
export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/widget/")) return widgetHeaders(request);
  let config;
  try {
    config = getConfig();
  } catch {
    // Not configured yet: a relative redirect, since without APP_URL there is no trusted origin.
    return new NextResponse(null, { status: 307, headers: { Location: "/login" } });
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(config.supabase.url, config.supabase.anonKey, {
    cookieOptions: { secure: config.appUrl.startsWith("https:") },
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

// Layouts cannot set response headers, so the per-widget CSP is set here, from the widget row on every request: changes
// to its origins or active flag apply at once. next.config.ts sends the static deny for every other path. Fails closed:
// a bad id, an unknown or inactive widget, a config or database error all give 'none', never a missing header or "*".
// No X-Frame-Options here: it cannot express a list of origins.
async function widgetHeaders(request: NextRequest) {
  let value = "'none'";
  try {
    const config = getConfig();
    const widget = await loadWidget(request.nextUrl.pathname.split("/")[2] ?? "");
    value = widgetFrameAncestors(widget, config.embedAllowedOrigins, config.appUrl);
  } catch (cause) {
    console.error("widget: frame-ancestors", cause);
  }
  const response = NextResponse.next();
  response.headers.set("Content-Security-Policy", `frame-ancestors ${value}`);
  return response;
}

export const config = { matcher: ["/app", "/app/:path*", "/widget/:path*"] };
