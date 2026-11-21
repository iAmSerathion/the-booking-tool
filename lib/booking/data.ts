import { loadAvailability, loadOffer } from "@/lib/availability/data";
import { freeSlots, withoutBooking } from "@/lib/core/availability";
import { linkPrefill, linkStatus, type Prefill } from "@/lib/core/links";
import type { Question } from "@/lib/core/questions";
import { type WidgetView, widgetEmbedOrigins } from "@/lib/core/widget";
import { getConfig } from "@/lib/config";
import { createAdminSupabase } from "@/lib/db/admin";
import { loadWidget } from "@/lib/widget/data";
import { hashToken, plausibleToken } from "./token";

// What the public booking pages and the booking action read: who can be booked, for which event type, the free times,
// and the confirmation behind a token. Service role, server code only; never send host ids to the browser.

// Where a booking comes from: the general page "/" (website default) or a member's page "/<slug>". eventType: an
// active event type's slug instead of the default one. A booking link "/l/<token>" fixes host and event type. A widget
// "/widget/<id>[/section]" fixes the event type and its hosts.
export type ChannelRef =
  | { kind: "page"; eventType?: string }
  | { kind: "person"; slug: string; eventType?: string }
  | { kind: "link"; token: string }
  | { kind: "widget"; id: string; view: WidgetView };

export type BookingHost = { id: string; name: string; meetAuto: boolean };
export type BookingEventType = { id: string; slug: string; title: string; description: string | null; durationMinutes: number; questions: Question[] };
// Links only: linkId (server side, passed to create_booking) and the cleaned prefill. The link's metadata never leaves
// the database. Widgets only: widgetId and the origins that may embed it (for the booking page).
export type BookingContext = {
  via: "page" | "person_link" | "link" | "widget";
  hosts: BookingHost[];
  eventType: BookingEventType;
  linkId?: string;
  prefill?: Prefill;
  widgetId?: string;
  embedOrigins?: string[];
};
// What the browser gets per free time.
export type PublicSlot = { start: string; end: string };

const slugPattern = /^[a-z0-9-]{1,60}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const settingString = (value: unknown) => (typeof value === "string" ? value : null);

// Null when the page does not exist: unknown or unbookable slug, unknown or inactive event type, or no default event
// type. The general page with nobody bookable still exists; it just has no hosts and so no free times.
export async function loadContext(ref: ChannelRef): Promise<BookingContext | null> {
  if (ref.kind === "link") return loadLinkContext(ref.token);
  if (ref.kind === "widget") return loadWidgetContext(ref.id);
  if (ref.kind === "person" && !slugPattern.test(ref.slug)) return null;
  if (ref.eventType !== undefined && !slugPattern.test(ref.eventType)) return null;
  const db = createAdminSupabase();

  const { data: rows, error } = await db.from("settings").select("key, value").in("key", ["website_mode", "website_person_id", "default_event_type_id"]);
  if (error) throw error;
  const settings = new Map((rows ?? []).map((row) => [row.key as string, row.value as unknown]));

  const types = db.from("event_types").select(eventTypeColumns).eq("active", true);
  const defaultId = settingString(settings.get("default_event_type_id"));
  if (ref.eventType === undefined && !uuidPattern.test(defaultId ?? "")) return null;
  const hosts = db.from("profiles").select("id, name, meet_auto").eq("active", true).eq("bookable", true).order("name").order("id");

  const [type, people] = await Promise.all([
    (ref.eventType === undefined ? types.eq("id", defaultId!) : types.eq("slug", ref.eventType)).maybeSingle(),
    ref.kind === "person" ? hosts.eq("slug", ref.slug) : hosts,
  ]);
  if (type.error) throw type.error;
  if (people.error) throw people.error;
  if (!type.data) return null;

  let list: BookingHost[] = (people.data ?? []).map((p) => ({ id: p.id, name: p.name, meetAuto: p.meet_auto }));
  if (ref.kind === "person" && list.length === 0) return null;
  // Website default "person": only that member while they can be booked, else everyone (as round robin).
  const chosen = settingString(settings.get("website_person_id"));
  if (ref.kind === "page" && settings.get("website_mode") === "person" && list.some((h) => h.id === chosen)) list = list.filter((h) => h.id === chosen);

  return { via: ref.kind === "page" ? "page" : "person_link", hosts: list, eventType: toEventType(type.data) };
}

const eventTypeColumns = "id, slug, title, description, duration_minutes, questions";
const toEventType = (t: { id: string; slug: string; title: string; description: string | null; duration_minutes: number; questions: Question[] | null }): BookingEventType => ({
  id: t.id,
  slug: t.slug,
  title: t.title,
  description: t.description,
  durationMinutes: t.duration_minutes,
  questions: t.questions ?? [],
});

// A booking link: null for unknown, used (single use), expired or revoked links, and when its host can no longer be
// booked or its event type is switched off. The page shows the same closed view for all of them.
async function loadLinkContext(token: string): Promise<BookingContext | null> {
  if (!plausibleToken(token)) return null;
  const db = createAdminSupabase();
  const { data: link, error } = await db
    .from("booking_links")
    .select("id, host_id, event_type_id, prefill, single_use, used_at, expires_at, revoked_at")
    .eq("token_hash", hashToken(token))
    .maybeSingle();
  if (error) throw error;
  if (!link || linkStatus(link, new Date()) !== "active") return null;
  const [type, host] = await Promise.all([
    db.from("event_types").select(eventTypeColumns).eq("id", link.event_type_id).eq("active", true).maybeSingle(),
    db.from("profiles").select("id, name, meet_auto").eq("id", link.host_id).eq("active", true).eq("bookable", true).maybeSingle(),
  ]);
  if (type.error) throw type.error;
  if (host.error) throw host.error;
  if (!type.data || !host.data) return null;
  const eventType = toEventType(type.data);
  return {
    via: "link",
    hosts: [{ id: host.data.id, name: host.data.name, meetAuto: host.data.meet_auto }],
    eventType,
    linkId: link.id,
    prefill: linkPrefill(link.prefill, eventType.questions),
  };
}

// A widget: null when it is unknown or inactive, its event type is switched off, or none of its hosts can be booked any
// more. Person mode books its one host, round robin all of them. No fallback to everyone: save_booking_widget and
// deactivation keep the hosts valid, and a widget without hosts shows the closed view.
async function loadWidgetContext(id: string): Promise<BookingContext | null> {
  const widget = await loadWidget(id);
  if (!widget?.active) return null;
  const db = createAdminSupabase();
  const [type, members] = await Promise.all([
    db.from("event_types").select(eventTypeColumns).eq("id", widget.event_type_id).eq("active", true).maybeSingle(),
    db.from("booking_widget_hosts").select("user_id").eq("widget_id", widget.id),
  ]);
  if (type.error) throw type.error;
  if (members.error) throw members.error;
  if (!type.data) return null;
  const { data: people, error } = await db
    .from("profiles")
    .select("id, name, meet_auto")
    .in(
      "id",
      members.data.map((m) => m.user_id),
    )
    .eq("active", true)
    .eq("bookable", true)
    .order("name")
    .order("id");
  if (error) throw error;
  const hosts = people.map((p) => ({ id: p.id, name: p.name, meetAuto: p.meet_auto })).slice(0, widget.mode === "person" ? 1 : undefined);
  if (hosts.length === 0) return null;
  const { embedAllowedOrigins, appUrl } = getConfig();
  return { via: "widget", hosts, eventType: toEventType(type.data), widgetId: widget.id, embedOrigins: widgetEmbedOrigins(widget, embedAllowedOrigins, appUrl) };
}

export const publicSlots = (slots: readonly PublicSlot[]): PublicSlot[] => slots.map(({ start, end }) => ({ start, end }));

// Everything a booking page shows: the context and the free times of all its hosts for the event type (cached busy
// times, at most a minute old; the booking action checks again without the cache).
export async function loadBookingPage(ref: ChannelRef): Promise<{ context: BookingContext; slots: PublicSlot[] } | null> {
  const context = await loadContext(ref);
  if (!context) return null;
  const offer = await loadOffer(
    context.hosts.map((h) => h.id),
    context.eventType.durationMinutes,
  );
  return { context, slots: publicSlots(offer.slots) };
}

// Round robin input: each host's newest page or widget booking (cancelled ones count too), null if none.
export async function lastRoundRobinBookings(hostIds: readonly string[]): Promise<Map<string, string | null>> {
  const db = createAdminSupabase();
  const rows = await Promise.all(
    hostIds.map(async (id) => {
      const { data, error } = await db
        .from("bookings")
        .select("created_at")
        .eq("host_id", id)
        .in("booked_via", ["page", "widget"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return [id, (data?.created_at as string | undefined) ?? null] as const;
    }),
  );
  return new Map(rows);
}

// Server only: hostId, googleEventId and inviteeEmail never go to the browser.
export type Confirmation = {
  bookingId: string;
  hostId: string;
  googleEventId: string | null;
  inviteeEmail: string;
  startsAt: string;
  endsAt: string;
  // The invitee's zone if they picked one, else the host's.
  timeZone: string;
  hostName: string;
  eventTitle: string;
  meetUrl: string | null;
  state: "booked" | "cancelled";
};

const confirmationColumns = "id, host_id, google_event_id, invitee_email, starts_at, ends_at, state, meet_url, invitee_timezone, profiles(name, timezone), event_types(title)";

// The booking behind an invitee token: the booking's own token (bookings.token_hash), else an extra link token
// (booking_tokens, e.g. from a reminder mail in M8). Null for anything unknown.
export async function loadConfirmation(token: unknown): Promise<Confirmation | null> {
  if (!plausibleToken(token)) return null;
  const db = createAdminSupabase();
  const hash = hashToken(token);
  let { data: row, error } = await db.from("bookings").select(confirmationColumns).eq("token_hash", hash).maybeSingle();
  if (error) throw error;
  if (!row) {
    const extra = await db.from("booking_tokens").select("booking_id").eq("token_hash", hash).maybeSingle();
    if (extra.error) throw extra.error;
    if (!extra.data) return null;
    ({ data: row, error } = await db.from("bookings").select(confirmationColumns).eq("id", extra.data.booking_id).maybeSingle());
    if (error) throw error;
    if (!row) return null;
  }
  // One-to-one joins; supabase-js types them as arrays without generated database types.
  const host = row.profiles as unknown as { name: string; timezone: string };
  const type = row.event_types as unknown as { title: string };
  return {
    bookingId: row.id,
    hostId: row.host_id,
    googleEventId: row.google_event_id,
    inviteeEmail: row.invitee_email,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timeZone: row.invitee_timezone ?? host.timezone,
    hostName: host.name,
    eventTitle: type.title,
    meetUrl: row.meet_url,
    state: row.state,
  };
}

// The times a booking can move to: the same host, the booking's own duration (not the event type's current one), and
// the booking itself neither blocking nor counting. Its current start is left out. The availability is returned too:
// the reschedule action needs the primary calendar, zone, buffer and daily maximum. fresh: ask Google without the cache.
export async function loadRescheduleOffer(booking: Pick<Confirmation, "hostId" | "startsAt" | "endsAt">, { fresh = false } = {}) {
  const availability = await loadAvailability(createAdminSupabase(), booking.hostId, { fresh });
  if (availability.state !== "ok") return { slots: [] as PublicSlot[], availability };
  const own = { start: new Date(booking.startsAt), end: new Date(booking.endsAt) };
  const slots = freeSlots({ ...withoutBooking(availability.input, own), durationMinutes: (own.end.getTime() - own.start.getTime()) / 60_000 })
    .filter((slot) => slot.start.getTime() !== own.start.getTime())
    .map((slot) => ({ start: slot.start.toISOString(), end: slot.end.toISOString() }));
  return { slots, availability };
}
