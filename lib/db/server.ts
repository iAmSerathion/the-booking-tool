import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";

// Supabase as the signed-in user (Row Level Security applies), for Server Components, actions and route handlers.
export async function createSupabase() {
  const { url, anonKey } = getConfig().supabase;
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(list) {
        try {
          for (const { name, value, options } of list) cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot set cookies; proxy.ts refreshes the session for /app instead.
        }
      },
    },
  });
}
