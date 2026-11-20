"use server";

import { refresh } from "next/cache";
import { parseRules, parseWindows, timeZones, weekdays } from "@/lib/core/settings";
import { createAdminSupabase } from "@/lib/db/admin";
import { createSupabase } from "@/lib/db/server";
import { revokeToken } from "@/lib/google/oauth";

// What a settings form shows after saving: an inline error, or a short confirmation.
export type ActionState = { error: string | null; saved: boolean };

const saved: ActionState = { error: null, saved: true };
const failed = (error: string): ActionState => ({ error, saved: false });
const generic = "Saving failed. Please try again.";

// Every action works on the signed-in member only; no id comes from the form, and RLS applies to every write.
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
export async function disconnectCalendar(): Promise<ActionState> {
  const { userId } = await signedIn();
  const admin = createAdminSupabase();
  const { data: token, error: readError } = await admin.rpc("google_refresh_token", { p_user_id: userId });
  if (readError) return failed("Disconnecting failed. Please try again.");
  // shortcut: once calendar push channels exist (M8), stop the channel here first, while access still works.
  if (token) await revokeToken(token as string);
  const { error } = await admin.rpc("google_connection_delete", { p_user_id: userId });
  if (error) return failed("Disconnecting failed. Please try again.");
  refresh();
  return saved;
}

// Calendars whose events count as busy. The primary calendar always does and stays first.
export async function setBusyCalendars(_state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, userId } = await signedIn();
  const { data: row, error: readError } = await supabase.from("calendar_connections").select("primary_calendar_id").eq("user_id", userId).maybeSingle();
  if (readError) return failed(generic);
  if (!row) return failed("Connect Google Calendar first.");
  const primary = row.primary_calendar_id;
  const chosen = [...new Set(form.getAll("calendar"))].filter((id): id is string => typeof id === "string" && id !== "" && id !== primary);
  const { error } = await supabase
    .from("calendar_connections")
    .update({ busy_calendar_ids: primary ? [primary, ...chosen] : chosen })
    .eq("user_id", userId);
  if (error) return failed(generic);
  refresh();
  return saved;
}

// One text field per weekday (day-1 … day-7). All days are checked first, then saved in one go.
export async function saveAvailability(_state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await signedIn();
  const days = [];
  for (const [index, name] of weekdays.entries()) {
    const parsed = parseWindows(String(form.get(`day-${index + 1}`) ?? ""));
    if ("error" in parsed) return failed(`${name}: ${parsed.error}`);
    days.push(parsed.windows);
  }
  // One call, one transaction: the week is saved completely or not at all.
  const { error } = await supabase.rpc("set_availability_week", { p_days: days });
  if (error) return failed(error.code === "23514" ? "Some time windows overlap." : generic);
  refresh();
  return saved;
}

export async function saveRules(_state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, userId } = await signedIn();
  const field = (name: string) => (form.get(name) as string | null) ?? null;
  const parsed = parseRules(
    {
      timezone: field("timezone"),
      buffer_minutes: field("buffer_minutes"),
      min_notice_hours: field("min_notice_hours"),
      max_bookings_per_day: field("max_bookings_per_day"),
      meet_auto: field("meet_auto"),
    },
    timeZones(),
  );
  if ("error" in parsed) return failed(parsed.error);
  // Only the columns members may update (column grant); select confirms RLS let the row through.
  const { data, error } = await supabase.from("profiles").update(parsed.rules).eq("id", userId).select("id");
  if (error || !data?.length) return failed(generic);
  refresh();
  return saved;
}
