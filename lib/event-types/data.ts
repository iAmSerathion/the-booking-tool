import type { Question } from "@/lib/core/questions";
import { createSupabase } from "@/lib/db/server";

// The admin Event types page, read through the member's RLS client (members may read event types and settings).

export type EventTypeRow = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  duration_minutes: number;
  questions: Question[];
  active: boolean;
};

export async function listEventTypes(): Promise<{ eventTypes: EventTypeRow[]; defaultId: string | null }> {
  const supabase = await createSupabase();
  const [types, setting] = await Promise.all([
    supabase.from("event_types").select("id, slug, title, description, duration_minutes, questions, active").order("title").order("id"),
    supabase.from("settings").select("value").eq("key", "default_event_type_id").maybeSingle(),
  ]);
  if (types.error) throw types.error;
  if (setting.error) throw setting.error;
  const value = setting.data?.value;
  return {
    eventTypes: types.data.map((t) => ({ ...t, questions: t.questions ?? [] })),
    defaultId: typeof value === "string" ? value : null,
  };
}
