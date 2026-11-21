"use client";

import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";
import type { BookingForm, BookingResult } from "@/lib/booking/actions";
import type { PublicSlot } from "@/lib/booking/data";
import type { Locale } from "@/lib/config";
import type { Prefill } from "@/lib/core/links";
import { cleanBookingInput, slotChip, validateBooking } from "@/lib/core/booking";
import { type Question, validateAnswers } from "@/lib/core/questions";
import { type MessageKey, t } from "@/lib/i18n";
import styles from "./booking.module.css";
import { SlotPicker, useHydrated, useInviteeZone } from "./slot-picker";

// The booking form: pick a day and time in the invitee's zone, enter details and answers, book. Everything is checked
// here for quick feedback and again in the server action, which redirects to the confirmation page on success.

export type BookingProps = {
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
  // Booking links and widgets: values the invitee can still change. A widget's prefill may arrive (or change) after
  // load; it then fills only the fields the invitee has not changed.
  prefill?: Prefill;
};

const noPrefill: Prefill = {};
// An answer the invitee has not changed still equals what was prefilled (or is empty).
const sameAnswer = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

type Answers = Record<string, string | string[]>;
const fieldNames = ["name", "email", "company", "phone", "topic"] as const;

export function Booking({ action, locale, defaultTimeZone, privacyUrl, now, eventType, hostName, meet, slots: initialSlots, prefill = noPrefill }: BookingProps) {
  const [timeZone, setTimeZone] = useInviteeZone(defaultTimeZone, prefill.timeZone);

  const [slots, setSlots] = useState(initialSlots);
  const [start, setStart] = useState<string | null>(null);
  const [fields, setFields] = useState({
    name: prefill.name ?? "",
    email: prefill.email ?? "",
    company: prefill.company ?? "",
    phone: prefill.phone ?? "",
    topic: prefill.topic ?? "",
    privacy: false,
  });
  const [answers, setAnswers] = useState<Answers>(prefill.answers ?? {});
  // Adjusting state while rendering, as React recommends for props that change: no effect, no extra paint.
  const [applied, setApplied] = useState(prefill);
  if (applied !== prefill) {
    setApplied(prefill);
    setFields((f) => {
      const next = { ...f };
      for (const name of fieldNames) if (prefill[name] !== undefined && f[name] === (applied[name] ?? "")) next[name] = prefill[name];
      return next;
    });
    setAnswers((a) => {
      const next = { ...a };
      for (const [id, value] of Object.entries(prefill.answers ?? {})) if (sameAnswer(a[id], applied.answers?.[id])) next[id] = value;
      return next;
    });
  }
  const [errors, setErrors] = useState<Record<string, MessageKey>>({});
  const [formError, setFormError] = useState<MessageKey | null>(null);
  const [pending, startTransition] = useTransition();
  const hydrated = useHydrated();
  // NaN until mounted: a submit before that counts as a bot (looksLikeBot).
  const startedAt = useRef(Number.NaN);
  const honeypot = useRef<HTMLInputElement>(null);
  useEffect(() => {
    startedAt.current = Date.now();
  }, []);

  const selected = slots.find((s) => s.start === start) ?? null;

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

      <SlotPicker locale={locale} now={now} slots={slots} timeZone={timeZone} onTimeZone={setTimeZone} start={start} onStart={setStart} />

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
        <button type="submit" className={styles.submit} disabled={pending || !hydrated}>
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
