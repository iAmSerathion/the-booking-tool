"use server";

import { refresh } from "next/cache";
import { signedIn } from "@/lib/auth/member";
import { hashToken, newToken } from "@/lib/booking/token";
import { getConfig } from "@/lib/config";
import { linkUrl, parseLinkForm } from "@/lib/core/links";
import type { Question } from "@/lib/core/questions";
import type { ActionState } from "@/lib/settings/actions";

// Create and revoke booking links in the admin. Writes go through the member's RLS client: the insert policy checks the
// host (self, or any active bookable host for admins) and the active event type; revoke_booking_link checks ownership.

// url: the new link, shown once. Only its hash is stored, so it can never be shown again.
export type CreateLinkState = ActionState & { url: string | null };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failed = (error: string): CreateLinkState => ({ error, saved: false, url: null });

export async function createLink(_state: CreateLinkState, form: FormData): Promise<CreateLinkState> {
  const { supabase, userId, isAdmin } = await signedIn();
  const eventTypeId = form.get("event_type_id");
  if (typeof eventTypeId !== "string" || !uuidPattern.test(eventTypeId)) return failed("Choose an event type.");
  // Members always link to themselves; only admins pick a host.
  const chosenHost = form.get("host_id");
  const hostId = isAdmin && typeof chosenHost === "string" && chosenHost ? chosenHost : userId;
  if (!uuidPattern.test(hostId)) return failed("Choose a host.");

  const { data: type, error: typeError } = await supabase.from("event_types").select("questions").eq("id", eventTypeId).eq("active", true).maybeSingle();
  if (typeError) return failed("Creating the link failed. Please try again.");
  if (!type) return failed("This event type is switched off.");
  const questions: Question[] = type.questions ?? [];

  const answers: Record<string, unknown> = {};
  for (const q of questions) {
    const values = form.getAll(`answer.${q.id}`).filter((v): v is string => typeof v === "string");
    answers[q.id] = q.type === "multi" ? values : values[0];
  }
  const keys = form.getAll("meta_key");
  const values = form.getAll("meta_value");
  const parsed = parseLinkForm(
    {
      name: form.get("name"),
      email: form.get("email"),
      company: form.get("company"),
      single_use: form.get("single_use"),
      expires_days: form.get("expires_days"),
    },
    answers,
    keys.map((key, i) => [key, values[i]]),
    questions,
  );
  if ("error" in parsed) return failed(parsed.error);

  const token = newToken();
  const { error } = await supabase.from("booking_links").insert({
    token_hash: hashToken(token),
    host_id: hostId,
    event_type_id: eventTypeId,
    prefill: parsed.prefill,
    metadata: parsed.metadata,
    single_use: parsed.singleUse,
    expires_at: parsed.expiresInDays === null ? null : new Date(Date.now() + parsed.expiresInDays * 86_400_000).toISOString(),
  });
  if (error) {
    // 42501: the policy refused it, e.g. the host is no longer bookable.
    if (error.code !== "42501") console.error("links: insert", error);
    return failed(error.code === "42501" ? "This host cannot take bookings right now." : "Creating the link failed. Please try again.");
  }
  refresh();
  return { error: null, saved: true, url: linkUrl(getConfig().appUrl, token) };
}

export async function revokeLink(_state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await signedIn();
  const id = form.get("link_id");
  if (typeof id !== "string" || !uuidPattern.test(id)) return { error: "Unknown link.", saved: false };
  const { data, error } = await supabase.rpc("revoke_booking_link", { p_link_id: id });
  if (error) return { error: "Revoking failed. Please try again.", saved: false };
  refresh();
  // False: already revoked, or not this member's link.
  return data === true ? { error: null, saved: true } : { error: "This link is already revoked or not yours.", saved: false };
}
