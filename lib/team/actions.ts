"use server";

import { refresh } from "next/cache";
import { signedIn } from "@/lib/auth/member";
import { getConfig } from "@/lib/config";
import { cleanInvite, inviteError, slugError } from "@/lib/core/team";
import { isWidgetId as isId } from "@/lib/core/widget";
import { createAdminSupabase } from "@/lib/db/admin";
import type { ActionState } from "@/lib/settings/actions";
import { deactivate } from "./deactivate";

// The team page: rights, link names, invites, deactivation, reactivation and who gets website bookings. Admins only: checked here,
// and again in the database (assert_is_admin; invite_profile checks the actor, which comes from the session, never
// from the form). The database also keeps at least one active admin.

const saved: ActionState = { error: null, saved: true };
const failed = (error: string): ActionState => ({ error, saved: false });
const notAdmin = "Only admins can change the team.";
const noMember = "This member does not exist.";

// 23514 and P0002 carry a message for the admin (see supabase/migrations/20261201000600_team.sql), 42501 means "no right".
function fail(error: { code?: string; message: string }): ActionState {
  if (error.code === "23514" || error.code === "P0002") return failed(error.message);
  if (error.code === "42501") return failed(notAdmin);
  if (error.code === "23505") return failed("This email or link name is taken.");
  console.error("team: save", error);
  return failed("Saving failed. Please try again.");
}

export async function setMemberRight(_state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, isAdmin } = await signedIn();
  if (!isAdmin) return failed(notAdmin);
  const id = form.get("profile_id");
  const right = form.get("right");
  if (!isId(id)) return failed(noMember);
  if (right !== "is_admin" && right !== "bookable") return failed("Unknown right.");
  const { error } = await supabase.rpc("set_person_rights", { p_person_id: id, p_rights: { [right]: form.get("on") === "true" } });
  if (error) return fail(error);
  refresh();
  return saved;
}

export async function setMemberSlug(_state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, isAdmin } = await signedIn();
  if (!isAdmin) return failed(notAdmin);
  const id = form.get("profile_id");
  if (!isId(id)) return failed(noMember);
  const slug = String(form.get("slug") ?? "").trim().toLowerCase();
  const invalid = slugError(slug);
  if (invalid) return failed(invalid);
  const { error } = await supabase.rpc("set_slug", { p_profile_id: id, p_slug: slug });
  // The constraint errors carry raw Postgres text, so they get their own wording.
  if (error?.code === "23505") return failed("This link name is taken.");
  if (error?.code === "23514") return failed("This link name is not allowed.");
  if (error) return fail(error);
  refresh();
  return saved;
}

// Creates the auth user with the service key (the Google sign-in later links to it by its verified email), then the
// profile. No mail is sent: the admin tells the person. If the profile cannot be created, the new auth user goes again.
export async function inviteMember(_state: ActionState, form: FormData): Promise<ActionState> {
  const { userId, isAdmin } = await signedIn();
  if (!isAdmin) return failed(notAdmin);
  const { appUrl, google } = getConfig();
  const input = cleanInvite(Object.fromEntries(form));
  const invalid = inviteError(input, google.hostedDomain);
  if (invalid) return failed(invalid);

  const admin = createAdminSupabase();
  const { data, error: userError } = await admin.auth.admin.createUser({ email: input.email, email_confirm: true });
  if (userError?.code === "email_exists") {
    const { data: member } = await admin.from("profiles").select("id").eq("email", input.email).maybeSingle();
    // shortcut: an auth user without a profile (refused strangers are deleted in /auth/callback) is not reused; add a
    // lookup by email if that ever happens in practice.
    return failed(member ? "Already in the team." : "This email already has an account without a team profile.");
  }
  if (userError || !data.user) {
    console.error("team: invite user", userError);
    return failed("Saving failed. Please try again.");
  }
  const { error } = await admin.rpc("invite_profile", {
    p_id: data.user.id,
    p_actor_id: userId,
    p_profile: { name: input.name, email: input.email, slug: input.slug, is_admin: input.isAdmin, bookable: input.bookable },
  });
  if (error) {
    await admin.auth.admin.deleteUser(data.user.id);
    return fail(error);
  }
  refresh();
  return { ...saved, message: `Invited. ${input.name} signs in at ${appUrl}/login with Google (${input.email}).` };
}

// Hands the member's future bookings, widgets and website bookings to a successor (see ./deactivate). The actor is the
// signed-in admin, never a form field.
export async function deactivateMember(_state: ActionState, form: FormData): Promise<ActionState> {
  const { userId, isAdmin } = await signedIn();
  if (!isAdmin) return failed(notAdmin);
  const id = form.get("profile_id");
  const to = form.get("to_id");
  if (!isId(id)) return failed("Choose a member to deactivate.");
  if (!isId(to)) return failed("Choose who takes over.");
  const result = await deactivate({ actorId: userId, personId: id, toId: to });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ...saved, message: result.message };
}

export async function reactivateMember(_state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, isAdmin } = await signedIn();
  if (!isAdmin) return failed(notAdmin);
  const id = form.get("profile_id");
  if (!isId(id)) return failed(noMember);
  const { error } = await supabase.rpc("reactivate_profile", { p_person_id: id });
  if (error) return fail(error);
  refresh();
  return saved;
}

export async function setWebsiteBookings(_state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, isAdmin } = await signedIn();
  if (!isAdmin) return failed(notAdmin);
  const mode = form.get("mode");
  if (mode !== "person" && mode !== "round_robin") return failed("Choose who gets the bookings.");
  const person = form.get("person_id");
  if (mode === "person" && !isId(person)) return failed("Choose a person.");
  const { error } = await supabase.rpc("set_website_bookings", { p_mode: mode, p_person_id: mode === "person" ? person : null });
  if (error) return fail(error);
  refresh();
  return saved;
}
