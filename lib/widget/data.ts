import { isWidgetId } from "@/lib/core/widget";
import { createAdminSupabase } from "@/lib/db/admin";

export type Widget = { id: string; name: string; mode: "person" | "round_robin"; event_type_id: string; allowed_origins: string[]; active: boolean };

// One widget by its public id, with the service role: visitors cannot read booking_widgets. Null for a malformed or
// unknown id; inactive widgets are returned, the callers decide. Shared by the proxy (frame-ancestors) and the booking
// context, so both see the same row.
export async function loadWidget(id: string): Promise<Widget | null> {
  if (!isWidgetId(id)) return null;
  const { data, error } = await createAdminSupabase()
    .from("booking_widgets")
    .select("id, name, mode, event_type_id, allowed_origins, active")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}
