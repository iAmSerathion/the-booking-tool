import type { CalendarEvent } from "@/lib/core/availability";
import { GoogleError, googleUrls } from "./oauth";

// Google Calendar v3: the calendar list, free/busy and the events of extra busy calendars. Creating and deleting
// booking events follow with the booking action.

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
