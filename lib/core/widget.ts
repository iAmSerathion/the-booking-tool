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

export const widgetPath = (id: string, view: WidgetView) => `/widget/${id}${view === "section" ? "/section" : ""}`;
// The confirmation stays under the widget path: every other page sends frame-ancestors 'none'.
export const widgetConfirmationPath = (id: string, view: WidgetView, token: string, fresh = false) => `${widgetPath(id, view)}/confirmed/${token}${fresh ? "?new=1" : ""}`;
