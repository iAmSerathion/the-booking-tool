import { type WidgetPrefill, type WidgetStep, widgetMessage, widgetStepMessages } from "@/lib/core/widget";

// What a widget page inside the host page's frame knows about the host and tells it. The bridge (app/widget/[id]/bridge.tsx)
// sets the verified parent origin, the prefill and the booking page; the booking reads them, and section steps report
// "top" and "booked". Browser only and in memory: never in the URL, history.state or storage, and written only in
// effects and events, never while rendering, so server requests never share state.

// The verified parent origin of a section. Without it nothing is posted (window mode, opened directly, foreign parent).
let target: string | null = null;

export function connectEmbed(origin: string): () => void {
  target = origin;
  return () => {
    target = null;
  };
}

function embedPost(type: "top" | "booked") {
  if (target) window.parent.postMessage(widgetMessage(type), target);
}

// Prefill (raw; the booking cleans it against the event type's questions) and booking page, read through
// useSyncExternalStore. A new snapshot only when something arrives, so it stays stable.
type State = { prefill: WidgetPrefill | null; bookingPage: string | null };
let state: State = { prefill: null, bookingPage: null };
const listeners = new Set<() => void>();

function update(next: Partial<State>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export const setWidgetPrefill = (prefill: WidgetPrefill) => update({ prefill });

export function connectBookingPage(bookingPage: string | null): () => void {
  update({ bookingPage });
  return () => update({ bookingPage: null });
}

export function subscribeEmbed(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const embedSnapshot = () => state;
const serverState: State = { prefill: null, bookingPage: null };
export const embedServerSnapshot = () => serverState;

// Section steps: the last one shown in this document and the bookings already reported, so a second run of the same
// effect (StrictMode, a page shown again) reports nothing twice.
let lastStep: WidgetStep | null = null;
const reportedTokens = new Set<string>();

export function reportStep(next: WidgetStep) {
  const { top, booked } = widgetStepMessages(lastStep, next);
  lastStep = next;
  if (top) embedPost("top");
  if (booked && next.token && !reportedTokens.has(next.token)) {
    reportedTokens.add(next.token);
    embedPost("booked");
  }
}
