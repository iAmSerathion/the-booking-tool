"use server";

import { refresh } from "next/cache";
import { signedIn } from "@/lib/auth/member";
import { parseQuestions } from "@/lib/core/questions";
import { isWidgetId as isId } from "@/lib/core/widget";
import type { ActionState } from "@/lib/settings/actions";

// Create, edit and switch event types, and choose the default one. Admins only: checked here, and again by
// save_event_type, set_event_type_active and set_default_event_type (assert_is_admin), which also validate the input.

const saved: ActionState = { error: null, saved: true };
const failed = (error: string): ActionState => ({ error, saved: false });
const notAdmin = "Only admins can change event types.";
const unknown = "This event type does not exist.";

// 23514 and P0002 carry a message for the admin, 42501 means "no right" (see the event type functions).
function fail(error: { code?: string; message: string }): ActionState {
  if (error.code === "23514" || error.code === "P0002") return failed(error.message);
  if (error.code === "42501") return failed(notAdmin);
  console.error("event types: save", error);
  return failed("Saving failed. Please try again.");
}

export async function saveEventType(_state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, isAdmin } = await signedIn();
  if (!isAdmin) return failed(notAdmin);
  const id = form.get("event_type_id") || null;
  if (id !== null && !isId(id)) return failed(unknown);
  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get("questions") ?? "[]"));
  } catch {
    raw = null;
  }
  const parsed = parseQuestions(raw);
  if ("error" in parsed) return failed(parsed.error);
  const duration = Number(form.get("duration_minutes"));

  const { error } = await supabase.rpc("save_event_type", {
    p_id: id,
    p_slug: String(form.get("slug") ?? ""),
    p_title: String(form.get("title") ?? ""),
    p_description: String(form.get("description") ?? ""),
    p_duration_minutes: Number.isInteger(duration) ? duration : null,
    p_questions: parsed.questions,
  });
  if (error) return fail(error);
  refresh();
  return saved;
}

export async function setEventTypeActive(_state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, isAdmin } = await signedIn();
  if (!isAdmin) return failed(notAdmin);
  const id = form.get("event_type_id");
  if (!isId(id)) return failed(unknown);
  const { error } = await supabase.rpc("set_event_type_active", { p_id: id, p_active: form.get("active") === "true" });
  if (error) return fail(error);
  refresh();
  return saved;
}

export async function setDefaultEventType(_state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, isAdmin } = await signedIn();
  if (!isAdmin) return failed(notAdmin);
  const id = form.get("event_type_id");
  if (!isId(id)) return failed(unknown);
  const { error } = await supabase.rpc("set_default_event_type", { p_id: id });
  if (error) return fail(error);
  refresh();
  return saved;
}
