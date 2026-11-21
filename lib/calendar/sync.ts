import { removeBookingEvent } from "@/lib/booking/google";
import { calendarChange, matchBooking, type GoogleEvent } from "@/lib/core/calendar-sync";
import { createAdminSupabase } from "@/lib/db/admin";
import { listEventChanges } from "@/lib/google/calendar";
import { googleAccess } from "@/lib/google/connection";
import { GoogleError } from "@/lib/google/oauth";
import { planBookingJobs } from "@/lib/jobs/plan";
import { sendCalendarMoveMail, sendCancelMails } from "@/lib/mail/booking";

// Sync of a host's primary calendar: after every push notification and every 15 minutes as a safety net. Google lists
// only what changed since the last sync token; calendarChange (lib/core/calendar-sync.ts) decides what it means for a
// booking. Every branch is idempotent, because a deferred event makes the whole batch come back with the old token.
// Server code only, with the service key.
//
// Rule: only the invitee's decline cancels; the host deleting the event cancels as the host. The SQL comment on
// calendar_booking_deleted says "deleted or declined", but a host's decline is only stored (that migration stays as is).
// No cache invalidation: updateTag only works in Server Actions, and the busy cache expires within a minute anyway.

type Db = ReturnType<typeof createAdminSupabase>;
export type SyncOutcome = "synced" | "busy" | "not_connected" | "failed";

type Row = {
  id: string;
  host_id: string;
  state: "booked" | "cancelled";
  starts_at: string;
  ends_at: string;
  invitee_email: string;
  guest_responses: Record<string, string> | null;
  google_change_until: string | null;
  google_event_id: string | null;
};

// A notification during a sync makes it go again once more; three rounds are plenty.
const maxRounds = 3;

export async function syncCalendar(userId: string, { now = () => new Date() }: { now?: () => Date } = {}): Promise<SyncOutcome> {
  const db = createAdminSupabase();
  for (let round = 0; round < maxRounds; round++) {
    const { data: claim, error } = await db.rpc("calendar_sync_claim", { p_user_id: userId });
    if (error) throw error;
    // Another sync runs; claim told it to go again afterwards.
    if (!claim) return round === 0 ? "busy" : "synced";
    const { sync_token: syncToken, primary_calendar_id: calendarId } = claim as { sync_token: string | null; primary_calendar_id: string | null };

    let nextToken: string | null = null;
    let deferred = false;
    let outcome: SyncOutcome = "synced";
    try {
      const access = calendarId ? await googleAccess(userId) : null;
      if (!access?.ok || !calendarId) {
        outcome = access && !access.ok && access.reason === "unavailable" ? "failed" : "not_connected";
      } else {
        const changes = await listEventChanges(access.token, calendarId, { syncToken, from: now() }).catch((cause) => {
          // Token too old: start over, from now.
          if (cause instanceof GoogleError && cause.code === "sync_token_gone") return listEventChanges(access.token, calendarId, { syncToken: null, from: now() });
          throw cause;
        });
        nextToken = changes.nextSyncToken;
        deferred = await applyEvents(db, userId, changes.events, now());
      }
    } catch (cause) {
      console.error("calendar sync", userId, cause);
      outcome = "failed";
    }
    // A deferred event keeps the old token, so the same change comes back next time.
    const { data: again } = await db.rpc("calendar_sync_release", {
      p_user_id: userId,
      p_sync_token: nextToken,
      p_save_token: outcome === "synced" && !deferred && nextToken !== null,
    });
    if (outcome !== "synced" || !again) return outcome;
  }
  return "synced";
}

// Applies every listed event; returns whether one had to wait.
async function applyEvents(db: Db, userId: string, events: GoogleEvent[], now: Date): Promise<boolean> {
  const ids = [...new Set(events.map((e) => e.id))];
  const found: Row[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db
      .from("bookings")
      .select("id, host_id, state, starts_at, ends_at, invitee_email, guest_responses, google_change_until, google_event_id")
      .eq("host_id", userId)
      .in("google_event_id", ids.slice(i, i + 100));
    if (error) throw error;
    found.push(...(data as Row[]));
  }

  let deferred = false;
  for (const event of events) {
    try {
      const row = matchBooking(event, found, userId);
      if (row && (await applyEvent(db, row, event, now)) === "deferred") deferred = true;
    } catch (cause) {
      // shortcut: a failing event neither stops the others nor holds the token (or it would replay every change since,
      // forever), so a transient database error loses that one change; a per-event retry queue would fix it.
      console.error("calendar sync: event", event.id, cause);
    }
  }
  return deferred;
}

async function applyEvent(db: Db, row: Row, event: GoogleEvent, now: Date): Promise<"done" | "deferred"> {
  const before = { startsAt: new Date(row.starts_at), endsAt: new Date(row.ends_at) };
  const decision = calendarChange(
    {
      state: row.state,
      ...before,
      inviteeEmail: row.invitee_email,
      responses: row.guest_responses ?? {},
      changingUntil: row.google_change_until ? new Date(row.google_change_until) : null,
    },
    event,
    now,
  );
  if (decision.defer) return "deferred";
  const { change, responses } = decision;

  if (change?.type === "deleted") {
    const { data: cancelled, error } = await db.rpc("calendar_booking_deleted", { p_booking_id: row.id });
    if (error) throw error;
    // The host deleted it, so only the invitee hears of it.
    if (cancelled) await sendCancelMails(row.id, { by: "host", reason: null, notifyHost: false });
    return "done";
  }

  if (change?.type === "declined") {
    // Like the cancel link: same keys (cancelled:<id>), so the invitee never gets two cancel mails. P0002: already done.
    const { error } = await db.rpc("cancel_booking", { p_booking_id: row.id, p_cancelled_by: "invitee", p_reason: null });
    if (error && error.code !== "P0002") throw error;
    if (!error) {
      await removeBookingEvent(row.host_id, row.google_event_id);
      await sendCancelMails(row.id, { by: "invitee", reason: null, notifyHost: true });
    }
    return "done";
  }

  if (!change && !responses) return "done";
  const moved = change?.type === "moved" ? change : null;
  const { data: applied, error } = await db.rpc("calendar_booking_update", {
    p_booking_id: row.id,
    p_plan: {
      ...(moved ? { moved: { starts_at: moved.startsAt.toISOString(), ends_at: moved.endsAt.toISOString() } } : {}),
      ...(responses ? { responses } : {}),
    },
  });
  if (error) throw error;
  if (applied && moved) {
    // The cancel trigger killed the old reminders; plan the new ones. The host made the move, so only the invitee hears.
    await planBookingJobs(row.id);
    await sendCalendarMoveMail(row.id, before);
  }
  return "done";
}
