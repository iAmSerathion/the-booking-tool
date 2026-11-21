"use client";

import Script from "next/script";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { type BookingWidgetApi, widgetBookedEvent, widgetPath, widgetUnavailableEvent } from "@/lib/core/widget";
import styles from "../settings/settings.module.css";

const fields = [
  ["name", "Name"],
  ["email", "Email"],
  ["company", "Company"],
  ["topic", "Topic"],
] as const;

// The client side of the playground: loads /widget.js like a host site, mounts the chosen widget as a section with the
// prefill from the form, and logs what the host site learns (the two events, no data). The prefill stays in memory.
export function Playground({ widgets, locale }: { widgets: { id: string; name: string }[]; locale: "de" | "en" }) {
  const [api, setApi] = useState<BookingWidgetApi | null>(null);
  const [failed, setFailed] = useState(false);
  const [id, setId] = useState(widgets[0].id);
  const [log, setLog] = useState<string[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const section = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = section.current;
    if (!element) return;
    const note = (event: Event) => {
      setLog((lines) => [...lines, event.type]);
      if (event.type === widgetUnavailableEvent) setUnavailable(true);
    };
    element.addEventListener(widgetBookedEvent, note);
    element.addEventListener(widgetUnavailableEvent, note);
    return () => {
      element.removeEventListener(widgetBookedEvent, note);
      element.removeEventListener(widgetUnavailableEvent, note);
      window.BookingWidget?.unmount(element);
    };
  }, []);

  const mount = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const prefill = Object.fromEntries(fields.map(([name]) => [name, String(form.get(name) ?? "")]));
    setUnavailable(false);
    setLog([]);
    if (section.current && api) api.mount(section.current, prefill);
  };

  return (
    <>
      <Script
        src="/widget.js"
        data-locale={locale}
        onReady={() => setApi(window.BookingWidget?.v === 1 ? window.BookingWidget : null)}
        onError={() => setFailed(true)}
      />
      <form onSubmit={mount} className={styles.form}>
        <div className={styles.field}>
          <label htmlFor="playground-widget">Widget</label>
          <select id="playground-widget" value={id} onChange={(e) => setId(e.target.value)}>
            {widgets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <fieldset className={styles.form}>
          <legend>Prefill (what the host site already knows)</legend>
          {fields.map(([name, label]) => (
            <div key={name} className={styles.field}>
              <label htmlFor={`playground-${name}`}>{label}</label>
              <input id={`playground-${name}`} name={name} type={name === "email" ? "email" : "text"} autoComplete="off" />
            </div>
          ))}
        </fieldset>
        <div className={styles.actions}>
          <button type="submit" disabled={!api}>
            Show section
          </button>
          <a href={widgetPath(id, "window")} data-booking-widget={id}>
            Open as window
          </a>
          {failed && (
            <p role="alert" className={styles.error}>
              The widget script did not load.
            </p>
          )}
        </div>
      </form>

      <section aria-labelledby="playground-log-heading" className={styles.section}>
        <h2 id="playground-log-heading">Events the host site receives</h2>
        <ul role="log" aria-label="Widget events">
          {log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
        {unavailable && (
          <p>
            The widget did not answer. A host site shows a plain link instead: <a href={widgetPath(id, "window")}>Book a time</a>
          </p>
        )}
      </section>

      <div ref={section} data-booking-section={id} className={styles.playgroundSection} />
    </>
  );
}

declare global {
  interface Window {
    BookingWidget?: BookingWidgetApi;
  }
}
