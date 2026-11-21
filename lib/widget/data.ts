import { isWidgetId } from "@/lib/core/widget";
import { createAdminSupabase } from "@/lib/db/admin";
import { createSupabase } from "@/lib/db/server";

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

export type WidgetListItem = Widget & { eventType: string; hosts: { id: string; name: string }[] };

// The admin Widgets page and the playground, through the member's RLS client (members may read widgets).
export async function listWidgets(): Promise<WidgetListItem[]> {
  const supabase = await createSupabase();
  const { data, error } = await supabase
    .from("booking_widgets")
    .select("id, name, mode, event_type_id, allowed_origins, active, event_types(title), booking_widget_hosts(user_id, profiles(name))")
    .order("created_at");
  if (error) throw error;
  // One-to-one joins; supabase-js types them as arrays without generated database types.
  return data.map(({ event_types, booking_widget_hosts, ...row }) => ({
    ...row,
    eventType: (event_types as unknown as { title: string }).title,
    hosts: (booking_widget_hosts as unknown as { user_id: string; profiles: { name: string } }[])
      .map((h) => ({ id: h.user_id, name: h.profiles.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));
}
