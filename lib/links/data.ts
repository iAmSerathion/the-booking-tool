import type { Question } from "@/lib/core/questions";
import { createSupabase } from "@/lib/db/server";

// The admin Links page, read through the member's RLS client: members see their own links, admins all.

export type LinkRow = {
  id: string;
  created_at: string;
  single_use: boolean;
  used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  prefill: { name?: unknown; email?: unknown };
  metadata: Record<string, unknown>;
  host: string;
  eventType: string;
};

// shortcut: newest 200 only, no paging; add paging when instances keep more links.
export async function loadLinks(): Promise<LinkRow[]> {
  const supabase = await createSupabase();
  const { data, error } = await supabase
    .from("booking_links")
    .select("id, created_at, single_use, used_at, expires_at, revoked_at, prefill, metadata, profiles(name), event_types(title)")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  // One-to-one joins; supabase-js types them as arrays without generated database types.
  return data.map(({ profiles, event_types, ...row }) => ({
    ...row,
    host: (profiles as unknown as { name: string }).name,
    eventType: (event_types as unknown as { title: string }).title,
  }));
}

export type LinkFormOptions = {
  eventTypes: { id: string; title: string; questions: Question[] }[];
  // Admins only: the hosts a link can point at (active and bookable, as the insert policy demands).
  hosts: { id: string; name: string }[];
};

export async function loadLinkFormOptions(isAdmin: boolean): Promise<LinkFormOptions> {
  const supabase = await createSupabase();
  const [types, hosts] = await Promise.all([
    supabase.from("event_types").select("id, title, questions").eq("active", true).order("title"),
    isAdmin ? supabase.from("profiles").select("id, name").eq("active", true).eq("bookable", true).order("name") : Promise.resolve({ data: [], error: null }),
  ]);
  if (types.error) throw types.error;
  if (hosts.error) throw hosts.error;
  return { eventTypes: types.data.map((t) => ({ ...t, questions: t.questions ?? [] })), hosts: hosts.data ?? [] };
}
