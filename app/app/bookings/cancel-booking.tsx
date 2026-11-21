"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { cancelBookingAsHost } from "@/lib/bookings/actions";
import { ActionForm } from "../settings/action-form";
import styles from "../settings/settings.module.css";

// Cancelling takes two steps: Google tells the invitee at once, so one click must not do it. The first button opens the
// confirmation (a disclosure), which takes the optional reason; "Keep booking" closes it and returns focus.
export function CancelBooking({ bookingId, invitee }: { bookingId: string; invitee: string }) {
  const [open, setOpen] = useState(false);
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <div className={styles.actions}>
        <button ref={trigger} type="button" aria-expanded={open} disabled={!hydrated} onClick={() => setOpen(!open)}>
          Cancel booking with {invitee}
        </button>
      </div>
      {open && (
        <ActionForm action={cancelBookingAsHost} submit="Yes, cancel booking">
          <p>Google Calendar tells {invitee} right away that the booking is cancelled. This cannot be undone.</p>
          <input type="hidden" name="booking_id" value={bookingId} />
          <label className={styles.field}>
            Reason (optional)
            {/* The confirmation opens on a click, so moving focus into it is expected. */}
            <input name="reason" maxLength={2000} autoFocus />
          </label>
          <div className={styles.actions}>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              Keep booking
            </button>
          </div>
        </ActionForm>
      )}
    </>
  );
}

const noSubscribe = () => () => {};
