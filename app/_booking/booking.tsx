"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import type { BookingForm, BookingResult } from "@/lib/booking/actions";
import type { PublicSlot } from "@/lib/booking/data";
import type { Locale } from "@/lib/config";
import { calendarMonths, cleanBookingInput, dayTitle, formatTime, slotChip, slotsByCustomerDay, timeZoneLabel, validateBooking } from "@/lib/core/booking";
import { addDays, weekday, zonedDay } from "@/lib/core/dates";
import { type Question, validateAnswers } from "@/lib/core/questions";
import { type MessageKey, t } from "@/lib/i18n";
import styles from "./booking.module.css";

// The booking form: pick a day and time in the invitee's zone, enter details and answers, book. Everything is checked
// here for quick feedback and again in the server action, which redirects to the confirmation page on success.

type Props = {
  action: (form: BookingForm) => Promise<BookingResult>;
  locale: Locale;
  // The instance zone: the server render and the fallback when the browser reports none.
  defaultTimeZone: string;
  privacyUrl: string | null;
  now: string;
  eventType: { title: string; description: string | null; durationMinutes: number; questions: Question[] };
  hostName: string | null;
  meet: boolean;
  slots: PublicSlot[];
};

type Answers = Record<string, string | string[]>;
const fieldNames = ["name", "email", "company", "phone", "topic"] as const;

const noSubscribe = () => () => {};
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "";

// Calendar labels from Intl, formatted in UTC so the calendar day never shifts.
const monthTitle = (y: number, m: number, locale: Locale) =>
  new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, 15)));
const weekdayNames = (locale: Locale) =>
  Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" }).format(new Date(Date.UTC(2024, 0, 1 + i, 12))));
const pad = (n: number) => String(n).padStart(2, "0");

export function Booking({ action, locale, defaultTimeZone, privacyUrl, now, eventType, hostName, meet, slots: initialSlots }: Props) {
  const detected = useSyncExternalStore(noSubscribe, browserZone, () => defaultTimeZone) || defaultTimeZone;
  const [chosenZone, setChosenZone] = useState<string | null>(null);
  const timeZone = chosenZone ?? detected;

  const [slots, setSlots] = useState(initialSlots);
  const [monthIndex, setMonthIndex] = useState(0);
  const [day, setDay] = useState<string | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [fields, setFields] = useState({ name: "", email: "", company: "", phone: "", topic: "", privacy: false });
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, MessageKey>>({});
  const [formError, setFormError] = useState<MessageKey | null>(null);
  const [pending, startTransition] = useTransition();
  // NaN until mounted: a submit before that counts as a bot (looksLikeBot).
  const startedAt = useRef(Number.NaN);
  const honeypot = useRef<HTMLInputElement>(null);
  useEffect(() => {
    startedAt.current = Date.now();
  }, []);

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
  const selected = slots.find((s) => s.start === start) ?? null;
  const dayStarts = day ? (byDay.get(day) ?? []) : [];

  const set = (name: keyof typeof fields, value: string | boolean) => setFields((f) => ({ ...f, [name]: value }));
  const errorText = (key: string) =>
    errors[key] && (
      <p id={`error-${key}`} className={styles.error}>
        {t(locale, errors[key])}
      </p>
    );
  const invalid = (key: string) => (errors[key] ? { "aria-invalid": true, "aria-describedby": `error-${key}` } : {});

  function focusFirst(keys: string[]) {
    const first = ["name", "email", "privacy", ...eventType.questions.map((q) => `answers.${q.id}`)].find((k) => keys.includes(k));
    if (first) document.querySelector<HTMLElement>(`[data-field="${first}"]`)?.focus();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const input = cleanBookingInput(fields);
    const found: Record<string, MessageKey> = { ...validateBooking(input, { privacyRequired: !!privacyUrl }) };
    for (const [id, key] of Object.entries(validateAnswers(eventType.questions, answers).errors)) if (key) found[`answers.${id}`] = key;
    setErrors(found);
    if (Object.keys(found).length) return focusFirst(Object.keys(found));
    if (!selected) {
      setFormError("booking.error.pickTime");
      return;
    }
    startTransition(async () => {
      const result = await action({
        ...fields,
        answers,
        start: selected.start,
        timeZone,
        honeypot: honeypot.current?.value ?? "",
        startedAt: startedAt.current,
      });
      // Success redirects; anything else comes back here.
      setErrors(result.fieldErrors ?? {});
      setFormError(result.error ?? null);
      if (result.slots) {
        // The time was taken: offer the fresh times and keep everything the invitee typed.
        setSlots(result.slots);
        setStart(null);
      }
      if (result.fieldErrors) focusFirst(Object.keys(result.fieldErrors));
    });
  }

  return (
    <div className={styles.layout}>
      <section className={styles.intro}>
        <h1>{eventType.title}</h1>
        {eventType.description && <p>{eventType.description}</p>}
        <ul className={styles.factList}>
          <li>{t(locale, "booking.minutes", { minutes: eventType.durationMinutes })}</li>
          {meet && <li>{t(locale, "booking.meet")}</li>}
          {hostName && <li>{t(locale, "booking.with", { name: hostName })}</li>}
        </ul>
      </section>

      <section className={styles.picker} aria-labelledby="choose-time">
        <h2 id="choose-time">{t(locale, "booking.chooseTime")}</h2>
        <label className={styles.label}>
          {t(locale, "booking.timeZone")}
          <select value={timeZone} onChange={(e) => setChosenZone(e.target.value)} className={styles.input}>
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
                  <button
                    key={d}
                    type="button"
                    className={styles.day}
                    disabled={!byDay.has(d)}
                    aria-pressed={d === day}
                    aria-label={dayTitle(d, locale)}
                    onClick={() => setDay(d)}
                  >
                    {i + 1}
                  </button>
                );
              })}
            </div>
            {day && dayStarts.length > 0 ? (
              <div className={styles.times} role="group" aria-label={t(locale, "booking.times", { day: dayTitle(day, locale) })}>
                {dayStarts.map((s) => (
                  <button key={s} type="button" className={styles.time} aria-pressed={s === start} onClick={() => setStart(s)}>
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

      <form className={styles.form} onSubmit={submit} noValidate aria-labelledby="details">
        <h2 id="details">{t(locale, "booking.details")}</h2>
        <p aria-live="polite" className={styles.chosen}>
          {selected && t(locale, "booking.selected", { slot: slotChip(new Date(selected.start), new Date(selected.end), timeZone, locale) })}
        </p>
        {fieldNames.map((name) => {
          const props = {
            id: `field-${name}`,
            "data-field": name,
            className: styles.input,
            value: fields[name],
            onChange: (e: { target: { value: string } }) => set(name, e.target.value),
            ...invalid(name),
          };
          return (
            <div key={name} className={styles.field}>
              <label htmlFor={`field-${name}`} className={styles.label}>
                {t(locale, `booking.${name}`)}
              </label>
              {name === "topic" ? (
                <textarea {...props} rows={3} />
              ) : (
                <input
                  {...props}
                  type={name === "email" ? "email" : name === "phone" ? "tel" : "text"}
                  autoComplete={{ name: "name", email: "email", company: "organization", phone: "tel" }[name]}
                  aria-required={name === "name" || name === "email"}
                />
              )}
              {errorText(name)}
            </div>
          );
        })}

        {eventType.questions.map((q) => (
          <QuestionField key={q.id} question={q} value={answers[q.id]} onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))} invalid={invalid(`answers.${q.id}`)}>
            {errorText(`answers.${q.id}`)}
          </QuestionField>
        ))}

        {privacyUrl && (
          <div className={styles.field}>
            <label className={styles.check}>
              <input type="checkbox" data-field="privacy" checked={fields.privacy} onChange={(e) => set("privacy", e.target.checked)} {...invalid("privacy")} />
              <span>
                {t(locale, "booking.privacy").split("{link}")[0]}
                <a href={privacyUrl} target="_blank" rel="noreferrer">
                  {t(locale, "booking.privacyLink")}
                </a>
                {t(locale, "booking.privacy").split("{link}")[1]}
              </span>
            </label>
            {errorText("privacy")}
          </div>
        )}

        {/* People never see or fill this; bots that fill every field do. */}
        <div className={styles.trap} aria-hidden="true">
          <label>
            {t(locale, "booking.honeypot")}
            <input ref={honeypot} name="website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>

        {formError && (
          <p role="alert" className={styles.alert}>
            {t(locale, formError)}
          </p>
        )}
        <button type="submit" className={styles.submit} disabled={pending}>
          {t(locale, pending ? "booking.submitting" : "booking.submit")}
        </button>
      </form>
    </div>
  );
}

// One event type question: choice as radios, multi as checkboxes, text as a text area.
function QuestionField({
  question,
  value,
  onChange,
  invalid,
  children,
}: {
  question: Question;
  value: string | string[] | undefined;
  onChange: (value: string | string[]) => void;
  invalid: object;
  children: React.ReactNode;
}) {
  const id = `answers.${question.id}`;
  if (question.type === "text") {
    return (
      <div className={styles.field}>
        <label htmlFor={id} className={styles.label}>
          {question.label}
        </label>
        <textarea
          id={id}
          data-field={id}
          className={styles.input}
          rows={3}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          aria-required={!!question.required}
          {...invalid}
        />
        {children}
      </div>
    );
  }
  const picked = Array.isArray(value) ? value : [];
  return (
    <fieldset className={styles.fieldset} {...invalid}>
      <legend className={styles.label}>{question.label}</legend>
      {(question.choices ?? []).map((choice, i) => (
        <label key={choice} className={styles.check}>
          <input
            type={question.type === "multi" ? "checkbox" : "radio"}
            name={id}
            data-field={i === 0 ? id : undefined}
            {...invalid}
            checked={question.type === "multi" ? picked.includes(choice) : value === choice}
            onChange={(e) =>
              onChange(question.type === "multi" ? (e.target.checked ? [...picked, choice] : picked.filter((c) => c !== choice)) : choice)
            }
          />
          {choice}
        </label>
      ))}
      {children}
    </fieldset>
  );
}
