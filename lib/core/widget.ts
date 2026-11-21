import { t } from "@/lib/i18n";

// Widgets: ids, embed origins and paths. Pure, shared by the proxy (frame-ancestors per request), the widget pages and
// the booking action, so the origins a widget may be framed by come from one place.

export const widgetIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isWidgetId = (value: unknown): value is string => typeof value === "string" && widgetIdPattern.test(value);

// The same rule as the database check embed_origins_valid: https with a dotted host, plain http only for localhost and
// 127.0.0.1, optional port, lowercase, no path. CSP host sources match the port exactly.
export const embedOriginPattern = /^(https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+|http:\/\/(localhost|127\.0\.0\.1))(:[0-9]{1,5})?$/;
export const maxEmbedOrigins = 20;

export type WidgetView = "window" | "section";
export type WidgetRow = { active: boolean; allowed_origins: readonly string[] | null };

// The origins that may frame a widget: none for a missing or inactive widget. Otherwise the widget's own list, or the
// instance-wide fallback (EMBED_ALLOWED_ORIGINS) when the widget has none, plus the instance itself so an admin can try
// the widget in the playground. Entries that do not pass the origin rule are dropped, so the list can never hold "*".
export function widgetEmbedOrigins(widget: WidgetRow | null, fallback: readonly string[], appUrl: string): string[] {
  if (!widget?.active) return [];
  const own = widget.allowed_origins ?? [];
  const list = (own.length ? own : fallback).filter((o) => embedOriginPattern.test(o));
  return [...new Set([...list, new URL(appUrl).origin])];
}

// The CSP frame-ancestors value for a widget page; 'none' when nothing may frame it.
export function widgetFrameAncestors(widget: WidgetRow | null, fallback: readonly string[], appUrl: string): string {
  const origins = widgetEmbedOrigins(widget, fallback, appUrl);
  return origins.length ? origins.join(" ") : "'none'";
}

// The admin's "allowed sites" field: one origin per line (commas and spaces work too), normalised like
// save_booking_widget does (trimmed, lowercase, no trailing "/", deduplicated, sorted), then checked with the database
// rule, so what the form accepts is exactly what the database stores.
export function parseOrigins(text: string): { origins: string[] } | { error: string } {
  const origins = [...new Set(text.split(/[\s,]+/).map((o) => o.toLowerCase().replace(/\/+$/, "")).filter(Boolean))].sort();
  const bad = origins.find((o) => !embedOriginPattern.test(o));
  if (bad) return { error: `"${bad}" is not an origin such as https://www.example.com (no path).` };
  if (origins.length > maxEmbedOrigins) return { error: `At most ${maxEmbedOrigins} allowed sites.` };
  return { origins };
}

// The code an embedding site copies. appUrl is the instance's validated origin (never a request header), id a widget id,
// locale picks the loader's labels and the button text; nothing else goes into the HTML. The section mounts once the
// deferred loader ran.
export function widgetSnippets(appUrl: string, id: string, locale: "de" | "en") {
  const script = `<script src="${appUrl}/widget.js" data-locale="${locale}" defer></script>`;
  const label = t(locale, "widget.title").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return {
    window: `${script}\n<a href="${appUrl}/widget/${id}" data-booking-widget="${id}">${label}</a>`,
    section: [
      script,
      `<div data-booking-section="${id}"></div>`,
      "<script>",
      '  addEventListener("DOMContentLoaded", function () {',
      `    var element = document.querySelector('[data-booking-section="${id}"]');`,
      "    // Optional prefill: { name, email, company, topic, answers: [{ id, answer }] }",
      "    if (window.BookingWidget) window.BookingWidget.mount(element, {});",
      "  });",
      "</script>",
    ].join("\n"),
  };
}

export const widgetPath = (id: string, view: WidgetView) => `/widget/${id}${view === "section" ? "/section" : ""}`;
// The confirmation stays under the widget path: every other page sends frame-ancestors 'none'.
export const widgetConfirmationPath = (id: string, view: WidgetView, token: string, fresh = false) => `${widgetPath(id, view)}/confirmed/${token}${fresh ? "?new=1" : ""}`;

// Protocol v1 between public/widget.js on the host page and the widget pages (postMessage). public/widget.js repeats
// these names and limits (it is a classic script without imports); tests/unit/widget-loader.test.ts checks they match.
// Every message is { source, v: 1, type, ... }; receivers ignore anything else. Messages carry no invitee data.
export const widgetMessageSource = "booking-widget";
export const widgetTriggerAttribute = "data-booking-widget";
export const widgetSectionAttribute = "data-booking-section";
export const widgetBookedEvent = "booking-widget:booked";
export const widgetUnavailableEvent = "booking-widget:unavailable";
export const widgetReadyTimeout = 15_000;
export const widgetMaxHeight = 10_000;

type Signal = "ready" | "close" | "top" | "booked";
export type WidgetMessage = { source: typeof widgetMessageSource; v: 1; type: Signal } | { source: typeof widgetMessageSource; v: 1; type: "height"; height: number };

export function widgetMessage(type: Signal): WidgetMessage;
export function widgetMessage(type: "height", height: number): WidgetMessage;
export function widgetMessage(type: WidgetMessage["type"], height = 0): WidgetMessage {
  if (type === "height") return { source: widgetMessageSource, v: 1, type, height: Math.min(widgetMaxHeight, Math.max(0, Math.round(height))) };
  return { source: widgetMessageSource, v: 1, type };
}

// The origin of the page that framed the widget (location.ancestorOrigins[0], else document.referrer), or null when it
// is not one of the widget's origins (widgetEmbedOrigins). The widget posts only to this origin, never to "*".
export function parentOrigin(candidates: readonly (string | null | undefined)[], allowed: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const origin = new URL(candidate).origin;
      if (allowed.includes(origin)) return origin;
    } catch {}
  }
  return null;
}

// The one message from the host page (section only): { type: "prefill", name, email, company, topic, answers } with
// answers as [{ id, answer }] (answer a string, or strings for a multi question; a v1 "question" field is ignored).
// Returns the raw values for linkPrefill, which cleans them against the event type's questions; null for anything else.
export type WidgetPrefill = { name: unknown; email: unknown; company: unknown; topic: unknown; answers: Record<string, unknown> };

export function readWidgetPrefill(data: unknown): WidgetPrefill | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.source !== widgetMessageSource || m.v !== 1 || m.type !== "prefill") return null;
  const answers: Record<string, unknown> = {};
  for (const pair of Array.isArray(m.answers) ? m.answers.slice(0, 20) : []) {
    if (pair && typeof pair === "object" && typeof pair.id === "string" && !Object.hasOwn(answers, pair.id)) answers[pair.id] = pair.answer;
  }
  return { name: m.name, email: m.email, company: m.company, topic: m.topic, answers };
}

// Steps in a section: every change brings the section's top into view; "booked" only for the change from the booking to
// its fresh confirmation in the same loaded section. Nothing on the first step (also after a reload).
export type WidgetStep = { step: "booking" | "booked" | "confirmed"; token: string | null };

export function widgetStepMessages(previous: WidgetStep | null, next: WidgetStep): { top: boolean; booked: boolean } {
  if (!previous || (previous.step === next.step && previous.token === next.token)) return { top: false, booked: false };
  return { top: true, booked: previous.step === "booking" && next.step === "booked" };
}

// Where a booking was made: widget.js adds the host page's path (location.pathname only) as ?page= to the frame URL.
export const widgetPageParam = "page";
export const widgetPageMax = 200;
const pagePattern = /^\/[A-Za-z0-9/_.-]*$/;

// The path without a trailing slash (except "/"), only plain letters, digits and "/_.-", at most 200 characters; else null.
export function cleanWidgetPage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let end = value.length;
  while (end > 1 && value.charAt(end - 1) === "/") end--;
  const path = value.slice(0, end);
  return path.length <= widgetPageMax && pagePattern.test(path) ? path : null;
}

// In the frame: the verified parent origin plus ?page= give the full link; null without either.
export function widgetBookingPage(origin: string | null, path: unknown): string | null {
  const page = cleanWidgetPage(path);
  return origin && page ? readWidgetBookingPage(`${origin}${page}`, [origin]) : null;
}

// On the server, again: http(s), an origin the widget allows, a clean path, no credentials, search or hash, written
// exactly as a browser would, at most 300 characters (the bookings.booking_page check). Else null: booked without a page.
export function readWidgetBookingPage(value: unknown, allowed: readonly string[]): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) return null;
  if (!allowed.includes(url.origin) || cleanWidgetPage(url.pathname) !== url.pathname) return null;
  const link = `${url.origin}${url.pathname}`;
  return link === value ? link : null;
}

// What widget.js offers the host page as window.BookingWidget.
export type BookingWidgetPrefill = { name?: string; email?: string; company?: string; topic?: string; answers?: { id: string; answer: string | string[] }[] };
export type BookingWidgetSection = { update(prefill: BookingWidgetPrefill): void; unmount(): void };
export type BookingWidgetApi = { v: 1; mount(element: HTMLElement, prefill?: BookingWidgetPrefill): BookingWidgetSection | null; unmount(element: HTMLElement): boolean };
