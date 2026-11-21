"use client";

import { type FormEvent, useState, useTransition } from "react";
import type { RescheduleForm, RescheduleResult } from "@/lib/booking/change";
import type { PublicSlot } from "@/lib/booking/data";
import type { Locale } from "@/lib/config";
import { slotChip } from "@/lib/core/booking";
import { type MessageKey, t } from "@/lib/i18n";
import styles from "../../_booking/booking.module.css";
import { SlotPicker, useHydrated, useInviteeZone } from "../../_booking/slot-picker";

// The picker plus the submit; success redirects to the confirmation page, anything else comes back here.
type Props = {
  action: (form: RescheduleForm) => Promise<RescheduleResult>;
  cancelHref: string;
  locale: Locale;
  defaultTimeZone: string;
  now: string;
  slots: PublicSlot[];
};

export function Reschedule({ action, cancelHref, locale, defaultTimeZone, now, slots: initialSlots }: Props) {
  const [timeZone, setTimeZone] = useInviteeZone(defaultTimeZone);
  const [slots, setSlots] = useState(initialSlots);
  const [start, setStart] = useState<string | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [pending, startTransition] = useTransition();
  const hydrated = useHydrated();
  const selected = slots.find((s) => s.start === start) ?? null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected) return setError("booking.error.pickTime");
    setError(null);
    startTransition(async () => {
      const result = await action({ start: selected.start, timeZone });
      setError(result.error);
      if (result.slots) {
        setSlots(result.slots);
        setStart(null);
      }
    });
  }

  return (
    <>
      <SlotPicker locale={locale} now={now} slots={slots} timeZone={timeZone} onTimeZone={setTimeZone} start={start} onStart={setStart} />
      <form className={styles.form} onSubmit={submit} noValidate aria-labelledby="new-time">
        <h2 id="new-time">{t(locale, "reschedule.newTime")}</h2>
        <p aria-live="polite" className={styles.chosen}>
          {selected && t(locale, "booking.selected", { slot: slotChip(new Date(selected.start), new Date(selected.end), timeZone, locale) })}
        </p>
        {error && (
          <p role="alert" className={styles.alert}>
            {t(locale, error)}
          </p>
        )}
        <button type="submit" className={styles.submit} disabled={pending || !hydrated}>
          {t(locale, pending ? "reschedule.submitting" : "reschedule.submit")}
        </button>
        <p className={styles.actions}>
          <a href={cancelHref}>{t(locale, "reschedule.cancelInstead")}</a>
        </p>
      </form>
    </>
  );
}
