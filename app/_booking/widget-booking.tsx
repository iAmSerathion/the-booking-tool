"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { BookingForm } from "@/lib/booking/actions";
import { linkPrefill } from "@/lib/core/links";
import { Booking, type BookingProps } from "./booking";
import { embedServerSnapshot, embedSnapshot, subscribeEmbed } from "./widget-embed";

// The booking inside a widget: the host page's prefill (arrives after load, cleaned here against the event type's
// questions; the server checks everything again) and the booking page go along.
export function WidgetBooking(props: Omit<BookingProps, "prefill">) {
  const { prefill: raw, bookingPage } = useSyncExternalStore(subscribeEmbed, embedSnapshot, embedServerSnapshot);
  const { questions } = props.eventType;
  const prefill = useMemo(() => (raw ? linkPrefill(raw, questions) : undefined), [raw, questions]);
  const { action } = props;
  const book = useCallback((form: BookingForm) => action({ ...form, bookingPage }), [action, bookingPage]);
  return <Booking {...props} action={book} prefill={prefill} />;
}
