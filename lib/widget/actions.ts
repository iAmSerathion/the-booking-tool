"use server";

import { refresh } from "next/cache";
import { signedIn } from "@/lib/auth/member";
import { isWidgetId, parseOrigins } from "@/lib/core/widget";
import type { ActionState } from "@/lib/settings/actions";

// Create, edit and switch widgets in the admin. Admins only: checked here, and again by save_booking_widget and
// set_booking_widget_active (assert_is_admin), which also validate hosts, event type and origins.

const saved: ActionState = { error: null, saved: true };
const failed = (error: string): ActionState => ({ error, saved: false });
const notAdmin = "Only admins can change widgets.";

// 23514 and P0002 carry a message for the admin, 42501 means "no right" (see the widget functions).
function fail(error: { code?: string; message: string }): ActionState {
  if (error.code === "23514" || error.code === "P0002") return failed(error.message);
  if (error.code === "42501") return failed(notAdmin);
  console.error("widgets: save", error);
  return failed("Saving failed. Please try again.");
}

export async function saveWidget(_state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, isAdmin } = await signedIn();
  if (!isAdmin) return failed(notAdmin);
  const id = form.get("widget_id") || null;
  if (id !== null && !isWidgetId(id)) return failed("This widget does not exist.");
  const mode = form.get("mode");
  if (mode !== "person" && mode !== "round_robin") return failed("Choose who gets the bookings.");
  const eventTypeId = form.get("event_type_id");
  if (!isWidgetId(eventTypeId)) return failed("Choose an event type.");
  const hosts = [...new Set(form.getAll("host_id"))].filter(isWidgetId);
  const origins = parseOrigins(String(form.get("allowed_origins") ?? ""));
  if ("error" in origins) return failed(origins.error);

  const { error } = await supabase.rpc("save_booking_widget", {
    p_id: id,
    p_name: String(form.get("name") ?? ""),
    p_mode: mode,
    p_host_ids: hosts,
    p_event_type_id: eventTypeId,
    p_allowed_origins: origins.origins,
  });
  if (error) return fail(error);
  refresh();
  return saved;
}

export async function setWidgetActive(_state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, isAdmin } = await signedIn();
  if (!isAdmin) return failed(notAdmin);
  const id = form.get("widget_id");
  if (!isWidgetId(id)) return failed("This widget does not exist.");
  const { error } = await supabase.rpc("set_booking_widget_active", { p_id: id, p_active: form.get("active") === "true" });
  if (error) return fail(error);
  refresh();
  return saved;
}
