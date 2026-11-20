"use server";

import { refresh } from "next/cache";
import { createAdminSupabase } from "@/lib/db/admin";
import { createSupabase } from "@/lib/db/server";
import { revokeToken } from "@/lib/google/oauth";

async function signedIn() {
  const supabase = await createSupabase();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) throw new Error("Not signed in");
  // RLS hides inactive profiles: deactivated members cannot change anything.
  const { data: profile } = await supabase.from("profiles").select("id").eq("id", userId).maybeSingle();
  if (!profile) throw new Error("No access");
  return { supabase, userId };
}

// Give the grant back to Google (best effort), then delete the token and the connection row.
export async function disconnectCalendar() {
  const { userId } = await signedIn();
  const admin = createAdminSupabase();
  const { data: token, error: readError } = await admin.rpc("google_refresh_token", { p_user_id: userId });
  if (readError) throw readError;
  // shortcut: once calendar push channels exist (M8), stop the channel here first, while access still works.
  if (token) await revokeToken(token as string);
  const { error } = await admin.rpc("google_connection_delete", { p_user_id: userId });
  if (error) throw error;
  refresh();
}

// Calendars whose events count as busy. The primary calendar always does and stays first.
export async function setBusyCalendars(form: FormData) {
  const { supabase, userId } = await signedIn();
  const { data: row, error: readError } = await supabase.from("calendar_connections").select("primary_calendar_id").eq("user_id", userId).maybeSingle();
  if (readError) throw readError;
  if (!row) return;
  const primary = row.primary_calendar_id;
  const chosen = [...new Set(form.getAll("calendar"))].filter((id): id is string => typeof id === "string" && id !== "" && id !== primary);
  const { error } = await supabase
    .from("calendar_connections")
    .update({ busy_calendar_ids: primary ? [primary, ...chosen] : chosen })
    .eq("user_id", userId);
  if (error) throw error;
  refresh();
}
