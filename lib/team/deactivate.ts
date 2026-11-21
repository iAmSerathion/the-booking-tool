import { randomBytes } from "node:crypto";
import { updateTag } from "next/cache";
import { busyCacheTag } from "@/lib/availability/data";
import { removeBookingEvent } from "@/lib/booking/google";
import { dropLease, takeLease } from "@/lib/booking/lease";
import { hashToken, newToken } from "@/lib/booking/token";
import { getConfig } from "@/lib/config";
import { eventSummary } from "@/lib/core/booking";
import { createAdminSupabase } from "@/lib/db/admin";
import { createEvent, deleteEvent, googleEventId } from "@/lib/google/calendar";
import { disconnectGoogle, googleAccess } from "@/lib/google/connection";
import { t } from "@/lib/i18n";

// Deactivates a member and hands everything to a successor. A plain module, NOT "use server": it runs with the service
// key and trusts actorId, which only the server action passes, from the session. Order:
// 1. new events for the member's future bookings in the successor's calendar (the invitee gets new invitations),
// 2. deactivate_profile with exactly those bookings and their new event ids (it also moves widget hosts and the website
//    person, and keeps at least one active admin),
// 3. delete the old events, while the member's Google connection still works,
// 4. revoke the member's Google grant and delete the connection.
// If 1 or 2 fails, the new events go again and nothing changed. After 2 nothing is rolled back.

export type DeactivateResult = { ok: true; message: string } | { ok: false; error: string };

type Booking = {
  id: string;
  starts_at: string;
  ends_at: string;
  invitee_name: string;
  invitee_email: string;
  google_event_id: string | null;
  meet_url: string | null;
  event_types: { title: string } | null;
};

const refused = (error: string): DeactivateResult => ({ ok: false, error });
const generic = refused("Deactivating failed. Please try again.");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function deactivate({ actorId, personId, toId }: { actorId: string; personId: string; toId: string }): Promise<DeactivateResult> {
  // Cheap checks before Google is touched; deactivate_profile checks all of them again under its locks.
  if (personId === actorId) return refused("You cannot deactivate yourself.");
  if (personId === toId) return refused("Please pick an active member to take over.");
  const db = createAdminSupabase();
  const { data: people, error: peopleError } = await db.from("profiles").select("id, name, active, bookable, timezone, meet_auto").in("id", [personId, toId]);
  if (peopleError) return generic;
  const person = people.find((p) => p.id === personId);
  const to = people.find((p) => p.id === toId);
  if (!person) return refused("This member does not exist.");
  if (!person.active) return refused("This member is already deactivated.");
  if (!to?.active) return refused("Please pick an active member to take over.");

  // The SQL compares with its own now(); a booking that starts in between makes it refuse with "changed", and a retry works.
  const { data, error: bookingsError } = await db
    .from("bookings")
    .select("id, starts_at, ends_at, invitee_name, invitee_email, google_event_id, meet_url, event_types(title)")
    .eq("host_id", personId)
    .eq("state", "booked")
    .gt("starts_at", new Date().toISOString());
  if (bookingsError) return generic;
  const bookings = data as unknown as Booking[];

  const plan: { id: string; google_event_id: string; meet_url: string | null }[] = [];
  const leased: string[] = [];
  let cleanUp = async () => {};
  try {
    if (bookings.length) {
      // The SQL checks this too, but only after the invitees got their new invitations.
      if (!to.bookable) return refused("The member who takes over must be bookable.");
      const [access, connection] = await Promise.all([
        googleAccess(toId),
        db.from("calendar_connections").select("primary_calendar_id").eq("user_id", toId).maybeSingle(),
      ]);
      const calendar = connection.data?.primary_calendar_id as string | undefined;
      if (!access.ok || !calendar) return refused(`${to.name} must connect Google Calendar first.`);

      // A reschedule that commits between building the plan and deactivate_profile would leave the new event at the old time.
      for (const booking of bookings) {
        if (!(await takeLease(booking.id))) return refused("A booking is being changed right now. Please try again.");
        leased.push(booking.id);
      }

      const { appUrl, locale } = getConfig();
      const summary = await db.from("settings").select("value").eq("key", "event_summary_template").maybeSingle();
      const template = typeof summary.data?.value === "string" && summary.data.value.trim() ? summary.data.value : t(locale, "booking.eventSummary");
      const created: string[] = [];
      const hashes: string[] = [];
      cleanUp = async () => {
        // sendUpdates "all": the invitees got the new invitations, so they also get the withdrawal. 404/410 count as done.
        for (const id of created) await deleteEvent(access.token, calendar, id, "all").catch((cause) => console.error("team: cleanup delete", cause));
        if (hashes.length) await db.from("booking_tokens").delete().in("token_hash", hashes);
      };

      try {
        for (const booking of bookings) {
          // The old confirmation link cannot be rebuilt (only its hash is stored), so the new event gets a link of its own.
          const token = newToken();
          const { error } = await db.from("booking_tokens").insert({ token_hash: hashToken(token), booking_id: booking.id });
          if (error) throw error;
          hashes.push(hashToken(token));
          // A fresh id, recorded before the insert so a lost response is cleaned up too.
          const eventId = googleEventId(booking.id) + randomBytes(4).toString("hex");
          created.push(eventId);
          const event = await createEvent(access.token, calendar, {
            bookingId: booking.id,
            eventId,
            summary: eventSummary(template, { event: booking.event_types?.title ?? "", invitee: booking.invitee_name, host: to.name }),
            description: t(locale, "booking.eventDescription", { link: `${appUrl}/confirmed/${token}` }),
            start: new Date(booking.starts_at),
            end: new Date(booking.ends_at),
            timeZone: to.timezone,
            attendees: [{ email: booking.invitee_email, displayName: booking.invitee_name }],
            // The invitee keeps a video call if the booking had one (deactivate_profile keeps the old link otherwise).
            meet: to.meet_auto || !!booking.meet_url,
          });
          plan.push({ id: booking.id, google_event_id: event.id, meet_url: event.meetUrl });
        }
      } catch (cause) {
        console.error("team: deactivate events", cause);
        await cleanUp();
        return refused("Google did not accept the new events. Nothing was changed.");
      }
    }

    const { error } = await db.rpc("deactivate_profile", { p_person_id: personId, p_to_id: toId, p_actor_id: actorId, p_plan: { bookings: plan } });
    if (error) {
      await cleanUp();
      return rpcRefusal(error);
    }
  } finally {
    for (const id of leased) await dropLease(id);
  }

  // Committed. Best effort from here on: report what is left behind instead of undoing the hand-over.
  let leftOver = 0;
  for (const booking of bookings) if (!(await removeBookingEvent(personId, booking.google_event_id))) leftOver++;
  const disconnected = await disconnectGoogle(personId);
  updateTag(busyCacheTag(personId));
  updateTag(busyCacheTag(toId));

  const notes = [`${person.name} is deactivated. ${plural(bookings.length, "upcoming booking")} moved to ${to.name}.`];
  if (leftOver) notes.push(`${plural(leftOver, "old event")} could not be removed from ${person.name}'s calendar; please delete them there.`);
  if (!disconnected) notes.push(`${person.name}'s Google connection could not be removed.`);
  return { ok: true, message: notes.join(" ") };
}

// 23514 and P0002 carry a message for the admin (see supabase/migrations/20261201000600_team.sql).
function rpcRefusal(error: { code?: string; message: string }): DeactivateResult {
  if (error.code === "23514" || error.code === "P0002") return refused(error.message);
  if (error.code === "42501") return refused("Only admins can change the team.");
  console.error("team: deactivate_profile", error);
  return generic;
}
