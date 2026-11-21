import { randomUUID } from "node:crypto";
import { embedOrigin } from "./env";
import { admin } from "./session";

// Widgets for the widget specs: each test creates its own (with its own hosts) and removes it, so tests stay parallel-safe
// and the seeded widget is left alone.
export const discoveryCall = "00000000-0000-4000-8000-000000000101";

export async function newWidget(hostIds: string[], { mode = "round_robin", active = true, origins = [embedOrigin] } = {}) {
  const { data, error } = await admin()
    .from("booking_widgets")
    .insert({ name: `Widget ${randomUUID().slice(0, 8)}`, mode, event_type_id: discoveryCall, allowed_origins: origins, active })
    .select("id")
    .single();
  if (error) throw error;
  if (hostIds.length) {
    const { error: hostError } = await admin().from("booking_widget_hosts").insert(hostIds.map((user_id) => ({ widget_id: data.id, user_id })));
    if (hostError) throw hostError;
  }
  return data.id as string;
}
// Bookings keep the row (widget_id is ON DELETE SET NULL); the hosts go with removeHost afterwards.
export const removeWidget = (id: string) => admin().from("booking_widgets").delete().eq("id", id);
