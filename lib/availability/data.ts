import type { SupabaseClient } from "@supabase/supabase-js";
import { cacheLife, cacheTag } from "next/cache";
import { type AvailabilityInput, calendarEventBlocks, freeSlots, type Slot } from "@/lib/core/availability";
import { addDays, dayStart, safeTimeZone, zonedDay } from "@/lib/core/dates";
import { windowsByDay } from "@/lib/core/settings";
import { createAdminSupabase } from "@/lib/db/admin";
import { type BusyBlock, freeBusy, listEvents } from "@/lib/google/calendar";
import { googleAccess } from "@/lib/google/connection";
import { calendarScope } from "@/lib/google/scopes";

// Free slots of hosts, from their windows and rules, Google busy times, their bookings and live holds. Server code only.
//
// Decision: a host without a working calendar connection is not bookable and offers no slots. That covers no connection,
// no calendar scope or primary calendar, needs_reconnect, and Google being unreachable. Without Google the tool cannot
// know when the host is busy and could not create the event, so offering times would only produce failed bookings.

type Busy = { ok: true; busy: BusyBlock[] } | { ok: false; reason: "not_connected" | "needs_reconnect" | "unavailable" };

// Google busy times per host and range, cached briefly for the public pages (at most a minute old). Errors are not
// kept, so the next request asks again. Arguments must stay serializable (cache key) and nothing here reads cookies.
async function cachedBusy(hostId: string, calendarIds: string[], primaryId: string, fromIso: string, toIso: string, timeZone: string): Promise<Busy> {
  "use cache";
  cacheTag(busyCacheTag(hostId));
  const result = await freshBusy(hostId, calendarIds, primaryId, fromIso, toIso, timeZone);
  if (result.ok) cacheLife({ stale: 30, revalidate: 30, expire: 60 });
  else cacheLife({ stale: 0, revalidate: 0, expire: 1 });
  return result;
}

// Invalidate with revalidateTag/updateTag after a booking or a change of busy calendars.
export const busyCacheTag = (hostId: string) => `google-busy-${hostId}`;

// Uncached, as the booking action needs it. Free/busy for every busy calendar, plus the events of the extra calendars,
// because free/busy skips events marked "free" (holidays). An extra calendar Google cannot read does not count.
async function freshBusy(hostId: string, calendarIds: string[], primaryId: string, fromIso: string, toIso: string, timeZone: string): Promise<Busy> {
  const access = await googleAccess(hostId);
  if (!access.ok) return { ok: false, reason: access.reason };
  const from = new Date(fromIso);
  const to = new Date(toIso);
  const entries = (calendarId: string) =>
    listEvents(access.token, calendarId, from, to)
      .then((events) => calendarEventBlocks(calendarId, events, timeZone).map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString() })))
      .catch(() => []);
  try {
    const [busy, ...others] = await Promise.all([freeBusy(access.token, calendarIds, from, to, primaryId), ...calendarIds.filter((id) => id !== primaryId).map(entries)]);
    return { ok: true, busy: [...busy, ...others.flat()] };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export type Availability =
  | {
      state: "ok";
      timeZone: string;
      primaryCalendarId: string;
      // Everything but the duration, so one Google fetch serves any event type (slotsFor).
      input: Omit<AvailabilityInput, "durationMinutes">;
    }
  | { state: "not_bookable" | "no_calendar" | "needs_reconnect" | "unavailable" };

// db: the service-role client on public pages and in the booking action. fresh: ask Google without the cache.
export async function loadAvailability(db: SupabaseClient, hostId: string, { fresh = false } = {}): Promise<Availability> {
  const [profile, connection, windows, horizon] = await Promise.all([
    db.from("profiles").select("timezone, buffer_minutes, min_notice_hours, max_bookings_per_day, active, bookable").eq("id", hostId).maybeSingle(),
    db.from("calendar_connections").select("scopes, status, primary_calendar_id, busy_calendar_ids").eq("user_id", hostId).maybeSingle(),
    db.from("availability_windows").select("weekday, start_time, end_time").eq("user_id", hostId),
    db.from("settings").select("value").eq("key", "slot_horizon_days").maybeSingle(),
  ]);
  if (profile.error || connection.error || windows.error || horizon.error) return { state: "unavailable" };
  const me = profile.data;
  if (!me?.active || !me.bookable) return { state: "not_bookable" };

  const row = connection.data;
  if (!row || !(row.scopes ?? []).includes(calendarScope) || !row.primary_calendar_id) return { state: "no_calendar" };
  if (row.status === "needs_reconnect") return { state: "needs_reconnect" };

  // profiles.timezone has no database check; an unknown zone would make every date helper throw.
  const timeZone = safeTimeZone(me.timezone, "");
  if (!timeZone) return { state: "unavailable" };

  const horizonDays = Number(horizon.data?.value ?? 14);
  const now = new Date();
  // From today 00:00 to the end of the last bookable day, so the range (and the cache key) stays the same all day.
  const today = zonedDay(now, timeZone);
  const from = dayStart(today, timeZone) ?? now;
  const to = dayStart(addDays(today, horizonDays + 1), timeZone) ?? new Date(now.getTime() + (horizonDays + 2) * 86_400_000);
  const calendarIds = [...new Set([row.primary_calendar_id, ...(row.busy_calendar_ids ?? [])])];

  const [result, bookings, holds] = await Promise.all([
    (fresh ? freshBusy : cachedBusy)(hostId, calendarIds, row.primary_calendar_id, from.toISOString(), to.toISOString(), timeZone),
    db.from("bookings").select("starts_at, ends_at").eq("host_id", hostId).eq("state", "booked").gte("starts_at", from.toISOString()).lt("starts_at", to.toISOString()),
    // Live holds: someone is booking that time right now. They block, but do not count toward the daily maximum.
    db.from("slot_holds").select("starts_at, ends_at").eq("host_id", hostId).gt("expires_at", now.toISOString()).lt("starts_at", to.toISOString()),
  ]);
  if (!result.ok) return result.reason === "needs_reconnect" ? { state: "needs_reconnect" } : result.reason === "not_connected" ? { state: "no_calendar" } : { state: "unavailable" };
  if (bookings.error || holds.error) return { state: "unavailable" };

  const blocks = (rows: { starts_at: string; ends_at: string }[]) => rows.map((r) => ({ start: new Date(r.starts_at), end: new Date(r.ends_at) }));
  return {
    state: "ok",
    timeZone,
    primaryCalendarId: row.primary_calendar_id,
    input: {
      windows: windowsByDay(windows.data ?? []),
      timeZone,
      busy: [...result.busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) })), ...blocks(holds.data ?? [])],
      bookings: blocks(bookings.data ?? []),
      bufferMinutes: me.buffer_minutes,
      minNoticeHours: me.min_notice_hours,
      maxBookingsPerDay: me.max_bookings_per_day,
      horizonDays,
      now,
    },
  };
}

// durationMinutes always comes from event_types.duration_minutes on the server, never from the client.
export function slotsFor(availability: Extract<Availability, { state: "ok" }>, durationMinutes: number): Slot[] {
  return freeSlots({ ...availability.input, durationMinutes });
}

// A start offered by at least one host. hostIds stay on the server: send only start and end to the browser.
export type SlotOffer = { start: string; end: string; hostIds: string[] };

// The union of the hosts' free slots for one event type, keyed by start. The per-host availability is returned too:
// the booking action needs each host's primary calendar and day bounds.
export async function loadOffer(hostIds: readonly string[], durationMinutes: number, { fresh = false } = {}) {
  const db = createAdminSupabase();
  const entries = await Promise.all(hostIds.map(async (id) => [id, await loadAvailability(db, id, { fresh })] as const));
  const byStart = new Map<string, SlotOffer>();
  for (const [hostId, availability] of entries) {
    if (availability.state !== "ok") continue;
    for (const slot of slotsFor(availability, durationMinutes)) {
      const start = slot.start.toISOString();
      const offer = byStart.get(start) ?? { start, end: slot.end.toISOString(), hostIds: [] };
      offer.hostIds.push(hostId);
      byStart.set(start, offer);
    }
  }
  return { slots: [...byStart.values()].sort((a, b) => a.start.localeCompare(b.start)), availability: new Map(entries) };
}
