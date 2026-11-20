import { createClient } from "@supabase/supabase-js";
import { getConfig } from "@/lib/config";

// Service-role Supabase: bypasses Row Level Security. Server code only, never import it from a client component.
export function createAdminSupabase() {
  const { url, serviceRoleKey } = getConfig().supabase;
  return createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
