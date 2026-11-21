// What a change in a host's Google calendar means for a booking, and the timing of push channels and safety syncs. Pure;
// Google and the database live in lib/calendar/.

// An event as events.list reports it (only the fields the sync reads). A deleted event comes as {id, status: "cancelled"}
// and nothing else, so bookings are matched by google_event_id, never by the booking id property.
export type GoogleAttendee = { email?: string; responseStatus?: string; self?: boolean; organizer?: boolean; resource?: boolean };
export type GoogleEvent = {
  id: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: GoogleAttendee[];
  extendedProperties?: { private?: Record<string, string> };
};

// The same mailbox: case does not count, nor a "+tag" before the @. Google reports a decline of an invitation sent to
// anna+test@example.com under anna@example.com.
export function mailboxKey(email: string | null | undefined): string {
  const value = (email ?? "").trim().toLowerCase();
  const at = value.lastIndexOf("@");
  return at < 0 ? value : value.slice(0, at).replace(/\+.*$/, "") + value.slice(at);
}

// The event's time; an all-day event (date only) is no meeting time and never counts as a move.
export function eventTimes(event: GoogleEvent): { start: Date; end: Date } | null {
  const start = event.start?.dateTime ? new Date(event.start.dateTime) : null;
  const end = event.end?.dateTime ? new Date(event.end.dateTime) : null;
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { start, end };
}

// Guest responses as Google reports them: lower-case email -> responseStatus. Rooms and other resources are skipped.
export function guestResponses(event: GoogleEvent): Record<string, string> {
  const responses: Record<string, string> = {};
  for (const attendee of event.attendees ?? []) {
    const email = (attendee.email ?? "").trim().toLowerCase();
    if (email && !attendee.resource) responses[email] = attendee.responseStatus ?? "needsAction";
  }
  return responses;
}

export type SyncBooking = {
  state: "booked" | "cancelled";
  startsAt: Date;
  endsAt: Date;
  inviteeEmail: string;
  // The guest responses seen last time.
  responses: Record<string, string>;
  // google_change_until: the tool itself is changing the event right now (an invitee reschedule).
  changingUntil: Date | null;
};

export type CalendarChange = { type: "moved"; startsAt: Date; endsAt: Date } | { type: "declined"; email: string } | { type: "deleted" };

export type CalendarDecision =
  // The tool is changing the event itself; the sync keeps the old sync token, so the change comes back next time.
  | { defer: true }
  // responses: the new guest responses to store, null when unchanged.
  | { defer: false; change: CalendarChange | null; responses: Record<string, string> | null };

const sameResponses = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

// What an event change means for a booking:
// - deleted in the host's calendar: the host cancelled it;
// - the invitee declined the invitation: cancelled by the invitee, like the cancel link (wins over anything else);
// - another time: the host moved it.
// Only the invitee's decline cancels. Other guests' responses and the host's own decline are only stored. A decline counts
// once, when the response switches to "declined". Deleting and declining apply only before the start (like the cancel
// link); a past booking moved into the future still counts as moved.
export function calendarChange(booking: SyncBooking, event: GoogleEvent, now: Date): CalendarDecision {
  // Before the state check, and strictly later: a lease ending right now no longer defers.
  if (booking.changingUntil && booking.changingUntil.getTime() > now.getTime()) return { defer: true };
  if (booking.state !== "booked") return { defer: false, change: null, responses: null };
  const upcoming = booking.startsAt.getTime() > now.getTime();

  if (event.status === "cancelled") return { defer: false, change: upcoming ? { type: "deleted" } : null, responses: null };

  const responses = guestResponses(event);
  const changedResponses = sameResponses(responses, booking.responses) ? null : responses;
  const invitee = mailboxKey(booking.inviteeEmail);
  const declined = Object.keys(responses).find(
    (email) => responses[email] === "declined" && booking.responses[email] !== "declined" && mailboxKey(email) === invitee,
  );
  if (declined && upcoming) return { defer: false, change: { type: "declined", email: declined }, responses: changedResponses };

  const times = eventTimes(event);
  const moved = times && (times.start.getTime() !== booking.startsAt.getTime() || times.end.getTime() !== booking.endsAt.getTime()) ? times : null;
  const relevant = moved && (upcoming || moved.start.getTime() > now.getTime());
  return { defer: false, change: relevant ? { type: "moved", startsAt: moved.start, endsAt: moved.end } : null, responses: changedResponses };
}

// The booking an event belongs to: only by its google_event_id, and only in its own host's calendar. Anything else is
// skipped: events the tool does not know, a booking being created right now, another install sharing the calendar (its
// events carry a booking_id property too, which is untrusted input and never looked up), and stale ids from a
// hand-over or a calendar account switch.
export function matchBooking<T extends { host_id: string; google_event_id: string | null; state: string }>(event: GoogleEvent, bookings: T[], userId: string): T | null {
  const own = bookings.filter((b) => b.google_event_id === event.id && b.host_id === userId);
  return own.find((b) => b.state === "booked") ?? own[0] ?? null;
}

// Push channels --------------------------------------------------------------------------------------------------------

// Google keeps a channel at most as long as asked; the tool asks for a week and renews it daily.
export const channelTtlSeconds = 7 * 24 * 3600;
export const channelRenewHours = 24;
// Safety net: sync when the last sync is older than this, in case a notification got lost.
export const safetySyncMinutes = 15;

// No renewal yet: now. No channel after a renewal (Google refused it): retry after an hour. Otherwise when the channel
// is a day old or expires within a day.
export function channelDue(p: { channelId: string | null; renewedAt: Date | null; expiresAt: Date | null; now: Date }): boolean {
  const now = p.now.getTime();
  if (!p.renewedAt) return true;
  if (!p.channelId || !p.expiresAt) return now - p.renewedAt.getTime() >= 3_600_000;
  return now - p.renewedAt.getTime() >= channelRenewHours * 3_600_000 || p.expiresAt.getTime() - now <= channelRenewHours * 3_600_000;
}

export function syncDue(lastSync: Date | null, now: Date): boolean {
  return !lastSync || now.getTime() - lastSync.getTime() >= safetySyncMinutes * 60_000;
}

// Google only notifies HTTPS addresses with a valid certificate. Without one (plain http) there is no channel, and the
// safety sync keeps the calendar current. The e2e fake (loopback only, enforced by config) accepts http.
export function webhookAddress(appUrl: string, fake: boolean): string | null {
  const url = `${appUrl.replace(/\/$/, "")}/api/google/calendar-webhook`;
  return fake || url.startsWith("https://") ? url : null;
}
