import type { CalendarEvent } from "@/lib/core/availability";
import { GoogleError, googleUrls } from "./oauth";

// Google Calendar v3: the calendar list, free/busy, the events of extra busy calendars, and creating, moving and deleting
// booking events.

export type CalendarEntry = { id: string; name: string; primary: boolean };

type ListEntry = { id: string; summary?: string; summaryOverride?: string; primary?: boolean; deleted?: boolean; hidden?: boolean };

// Every calendar in the member's list (own, shared, subscribed such as holidays), primary first.
export async function listCalendars(accessToken: string): Promise<CalendarEntry[]> {
  const entries: ListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ maxResults: "250", ...(pageToken ? { pageToken } : {}) });
    const response = await fetch(`${googleUrls.calendar()}/users/me/calendarList?${params}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    const data = (await response.json().catch(() => ({}))) as { items?: ListEntry[]; nextPageToken?: string; error?: { status?: string } };
    if (!response.ok) throw new GoogleError(data.error?.status ?? "calendar_list", response.status);
    entries.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return entries
    .filter((entry) => !entry.deleted && !entry.hidden)
    .map((entry) => ({ id: entry.id, name: entry.summaryOverride || entry.summary || entry.id, primary: !!entry.primary }))
    .sort((a, b) => Number(b.primary) - Number(a.primary));
}

export type BusyBlock = { start: string; end: string };

type FreeBusyResponse = {
  calendars?: Record<string, { busy?: BusyBlock[]; errors?: { reason?: string }[] }>;
  error?: { status?: string };
};

// Busy times (ISO) of the calendars that count as busy. Google takes at most 50 calendars per request.
// An extra calendar Google cannot read (no longer shared, say) is skipped; for the primary calendar that is an error,
// or the host would look free.
export async function freeBusy(accessToken: string, calendarIds: string[], from: Date, to: Date, primaryId: string): Promise<BusyBlock[]> {
  const busy: BusyBlock[] = [];
  for (let i = 0; i < calendarIds.length; i += 50) {
    const ids = calendarIds.slice(i, i + 50);
    const response = await fetch(`${googleUrls.calendar()}/freeBusy`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: ids.map((id) => ({ id })) }),
      cache: "no-store",
    });
    const data = (await response.json().catch(() => ({}))) as FreeBusyResponse;
    if (!response.ok) throw new GoogleError(data.error?.status ?? "free_busy", response.status);
    for (const id of ids) {
      const calendar = data.calendars?.[id];
      if (!calendar || calendar.errors?.length) {
        if (id === primaryId) throw new GoogleError("free_busy_primary", response.status);
        continue;
      }
      busy.push(...(calendar.busy ?? []));
    }
  }
  return busy;
}

// Events of an extra busy calendar in a range, with only the fields calendarEventBlocks needs. Free/busy skips events
// marked "free", which is how Google lists every holiday. Recurring events come as single instances.
export async function listEvents(accessToken: string, calendarId: string, from: Date, to: Date): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: "true",
      maxResults: "2500",
      fields: "items(status,start,end,description,eventType,attendees(self,responseStatus)),nextPageToken",
      ...(pageToken ? { pageToken } : {}),
    });
    const response = await fetch(`${googleUrls.calendar()}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    const data = (await response.json().catch(() => ({}))) as { items?: CalendarEvent[]; nextPageToken?: string; error?: { status?: string } };
    if (!response.ok) throw new GoogleError(data.error?.status ?? "events_list", response.status);
    events.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return events;
}

// The private extended property that marks an event as a booking of this tool; the calendar sync (M8) reads it.
export const bookingIdProperty = "booking_id";

export type NewEvent = {
  bookingId: string;
  summary: string;
  description: string;
  start: Date;
  end: Date;
  timeZone: string;
  attendees: { email: string; displayName?: string }[];
  meet: boolean;
  // Another event id than googleEventId(bookingId), for a booking that moves to another calendar: the invitee's calendar
  // still holds the old event under the old id, and Google answers 409 in a calendar that ever held it. Also the Meet
  // request id, so Google does not take it for a repeat of the old request.
  eventId?: string;
};

type EventResponse = {
  id?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  error?: { status?: string };
};

const eventsUrl = (calendarId: string) => `${googleUrls.calendar()}/calendars/${encodeURIComponent(calendarId)}/events`;

// Ids of the booking events (with the booking id property) in a calendar that start at or after `from`.
export async function listBookingEvents(accessToken: string, calendarId: string, from: Date): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      timeMin: from.toISOString(),
      singleEvents: "true",
      maxResults: "2500",
      fields: "items(id,status,start,extendedProperties),nextPageToken",
      ...(pageToken ? { pageToken } : {}),
    });
    const response = await fetch(`${eventsUrl(calendarId)}?${params}`, { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" });
    type Item = { id: string; status?: string; start?: { dateTime?: string }; extendedProperties?: { private?: Record<string, string> } };
    const data = (await response.json().catch(() => ({}))) as { items?: Item[]; nextPageToken?: string; error?: { status?: string } };
    if (!response.ok) throw new GoogleError(data.error?.status ?? "events_list", response.status);
    for (const item of data.items ?? [])
      // timeMin also returns events that started before `from` and still run.
      if (item.status !== "cancelled" && item.extendedProperties?.private?.[bookingIdProperty] && Date.parse(item.start?.dateTime ?? "") >= from.getTime())
        ids.push(item.id);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return ids;
}

// The event id we choose for a booking: its UUID without dashes, which is valid base32hex (a-v, 0-9) for Google. Knowing
// it lets the caller delete the event after a lost insert response, and Google answers a repeated id with 409 instead of
// a second event and invitation.
export const googleEventId = (bookingId: string) => bookingId.replace(/-/g, "").toLowerCase();

// A booking event in the host's primary calendar with the invitee as guest. sendUpdates=all: Google sends the invitation.
// With meet, Google adds a Meet conference (needs conferenceDataVersion=1).
export async function createEvent(accessToken: string, calendarId: string, event: NewEvent): Promise<{ id: string; meetUrl: string | null }> {
  const params = new URLSearchParams({ sendUpdates: "all", conferenceDataVersion: "1" });
  const response = await fetch(`${eventsUrl(calendarId)}?${params}`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      id: event.eventId ?? googleEventId(event.bookingId),
      summary: event.summary,
      description: event.description,
      start: { dateTime: event.start.toISOString(), timeZone: event.timeZone },
      end: { dateTime: event.end.toISOString(), timeZone: event.timeZone },
      attendees: event.attendees,
      guestsCanModify: false,
      reminders: { useDefault: true },
      extendedProperties: { private: { [bookingIdProperty]: event.bookingId } },
      ...(event.meet ? { conferenceData: { createRequest: { requestId: event.eventId ?? event.bookingId, conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
    }),
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as EventResponse;
  if (!response.ok || !data.id) throw new GoogleError(data.error?.status ?? "event_insert", response.status);
  const video = data.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri;
  return { id: data.id, meetUrl: data.hangoutLink ?? video ?? null };
}

// Already gone (404, 410) counts as done. sendUpdates "none" when rolling back a booking that never got saved, so the
// invitee does not get a cancellation right after the invitation.
export async function deleteEvent(accessToken: string, calendarId: string, eventId: string, sendUpdates: "all" | "none" = "all"): Promise<void> {
  const response = await fetch(`${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}?${new URLSearchParams({ sendUpdates })}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!response.ok && response.status !== 404 && response.status !== 410) throw new GoogleError("event_delete", response.status);
}

// Moves a booking event to a new time; guests, Meet and everything else stay. sendUpdates=all: the invitee gets the move
// (and, on a rollback, the move back) from Google.
export async function moveEvent(accessToken: string, calendarId: string, eventId: string, time: { start: Date; end: Date; timeZone: string }): Promise<void> {
  const response = await fetch(`${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}?${new URLSearchParams({ sendUpdates: "all" })}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      start: { dateTime: time.start.toISOString(), timeZone: time.timeZone },
      end: { dateTime: time.end.toISOString(), timeZone: time.timeZone },
    }),
    cache: "no-store",
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as EventResponse;
    throw new GoogleError(data.error?.status ?? "event_patch", response.status);
  }
}
