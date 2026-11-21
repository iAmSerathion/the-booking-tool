import { createSupabase } from "@/lib/db/server";

export type TeamMember = { id: string; name: string; email: string; slug: string | null; is_admin: boolean; bookable: boolean; active: boolean };
export type WebsiteSetting = { mode: "person" | "round_robin"; personId: string | null };

// The team page: every member (RLS lets active members read the team, inactive rows included) and who gets website
// bookings. Active members first, then by when they joined.
export async function loadTeam(): Promise<{ members: TeamMember[]; website: WebsiteSetting }> {
  const supabase = await createSupabase();
  const [members, settings] = await Promise.all([
    supabase.from("profiles").select("id, name, email, slug, is_admin, bookable, active").order("active", { ascending: false }).order("created_at"),
    supabase.from("settings").select("key, value").in("key", ["website_mode", "website_person_id"]),
  ]);
  if (members.error) throw members.error;
  if (settings.error) throw settings.error;
  const value = new Map(settings.data.map((row) => [row.key as string, row.value as unknown]));
  return {
    members: members.data as TeamMember[],
    website: {
      mode: value.get("website_mode") === "person" ? "person" : "round_robin",
      personId: typeof value.get("website_person_id") === "string" ? (value.get("website_person_id") as string) : null,
    },
  };
}
