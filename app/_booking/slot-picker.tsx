"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import type { PublicSlot } from "@/lib/booking/data";
import type { Locale } from "@/lib/config";
import { calendarMonths, dayTitle, formatTime, slotsByCustomerDay, timeZoneLabel } from "@/lib/core/booking";
import { addDays, weekday, zonedDay } from "@/lib/core/dates";
import { t } from "@/lib/i18n";
import styles from "./booking.module.css";

// Day and time picker in the invitee's zone, shared by the booking and the reschedule page.

const noSubscribe = () => () => {};
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "";

// The browser's zone (the instance zone on the server and before hydration), until the invitee picks another.
export function useInviteeZone(defaultTimeZone: string): [string, (zone: string) => void] {
  const detected = useSyncExternalStore(noSubscribe, browserZone, () => defaultTimeZone) || defaultTimeZone;
  const [chosen, setChosen] = useState<string | null>(null);
  return [chosen ?? detected, setChosen];
}

// Calendar labels from Intl, formatted in UTC so the calendar day never shifts.
const monthTitle = (y: number, m: number, locale: Locale) =>
  new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, 15)));
const weekdayNames = (locale: Locale) =>
  Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" }).format(new Date(Date.UTC(2024, 0, 1 + i, 12))));
const pad = (n: number) => String(n).padStart(2, "0");

type Props = {
  locale: Locale;
  now: string;
  slots: PublicSlot[];
  timeZone: string;
  onTimeZone: (zone: string) => void;
  start: string | null;
  onStart: (start: string) => void;
};

export function SlotPicker({ locale, now, slots, timeZone, onTimeZone, start, onStart }: Props) {
  const [monthIndex, setMonthIndex] = useState(0);
  const [day, setDay] = useState<string | null>(null);

  // The zone list and its Intl names depend on the browser's ICU data, which the server cannot know: until mounted (server
  // render and hydration) the select has only the current zone under its bare id, afterwards every zone with its name.
  const mounted = useSyncExternalStore(noSubscribe, () => true, () => false);
  const zones = useMemo(() => {
    if (!mounted) return [timeZone];
    const all = Intl.supportedValuesOf("timeZone");
    return all.includes(timeZone) ? all : [timeZone, ...all];
  }, [mounted, timeZone]);
  const byDay = useMemo(() => slotsByCustomerDay(slots.map((s) => s.start), timeZone), [slots, timeZone]);
  const months = calendarMonths([...byDay.keys()], zonedDay(new Date(now), timeZone));
  const [year, month] = months[Math.min(monthIndex, months.length - 1)];
  const firstDay = `${year}-${pad(month)}-01`;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dayStarts = day ? (byDay.get(day) ?? []) : [];

  return (
    <section className={styles.picker} aria-labelledby="choose-time">
      <h2 id="choose-time">{t(locale, "booking.chooseTime")}</h2>
      <label className={styles.label}>
        {t(locale, "booking.timeZone")}
        <select value={timeZone} onChange={(e) => onTimeZone(e.target.value)} className={styles.input}>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {mounted ? timeZoneLabel(zone, new Date(now), locale) : zone}
            </option>
          ))}
        </select>
      </label>

      {slots.length === 0 ? (
        <p>{t(locale, "booking.noSlots")}</p>
      ) : (
        <>
          <div className={styles.monthBar}>
            <button type="button" className={styles.nav} onClick={() => setMonthIndex(monthIndex - 1)} disabled={monthIndex === 0} aria-label={t(locale, "booking.prevMonth")}>
              ‹
            </button>
            <h3 aria-live="polite">{monthTitle(year, month, locale)}</h3>
            <button
              type="button"
              className={styles.nav}
              onClick={() => setMonthIndex(monthIndex + 1)}
              disabled={monthIndex >= months.length - 1}
              aria-label={t(locale, "booking.nextMonth")}
            >
              ›
            </button>
          </div>
          <div className={styles.calendar} role="group" aria-label={t(locale, "booking.days")}>
            {weekdayNames(locale).map((name) => (
              <span key={name} aria-hidden="true" className={styles.weekday}>
                {name}
              </span>
            ))}
            {Array.from({ length: weekday(firstDay) }, (_, i) => (
              <span key={`gap-${i}`} />
            ))}
            {Array.from({ length: daysInMonth }, (_, i) => {
              const d = addDays(firstDay, i);
              return (
                <button key={d} type="button" className={styles.day} disabled={!byDay.has(d)} aria-pressed={d === day} aria-label={dayTitle(d, locale)} onClick={() => setDay(d)}>
                  {i + 1}
                </button>
              );
            })}
          </div>
          {day && dayStarts.length > 0 ? (
            <div className={styles.times} role="group" aria-label={t(locale, "booking.times", { day: dayTitle(day, locale) })}>
              {dayStarts.map((s) => (
                <button key={s} type="button" className={styles.time} aria-pressed={s === start} onClick={() => onStart(s)}>
                  {formatTime(new Date(s), timeZone, locale)}
                </button>
              ))}
            </div>
          ) : (
            <p className={styles.muted}>{t(locale, "booking.pickDay")}</p>
          )}
        </>
      )}
    </section>
  );
}
