import { GoogleError, googleUrls } from "./oauth";

// Google Calendar v3. Only the calendar list for now; free/busy and events follow with availability and bookings.

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
