"use client";

import { type FormEvent, type ReactNode, startTransition, useActionState } from "react";
import type { ActionState } from "@/lib/settings/actions";
import styles from "./settings.module.css";

// A settings form with its result shown inline next to the button. Submitting through onSubmit (not the action prop)
// keeps what the member typed when the server refuses it; React would otherwise reset the form.
export function ActionForm({
  action,
  submit,
  children,
}: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  submit: string;
  children?: ReactNode;
}) {
  const [state, dispatch, pending] = useActionState(action, { error: null, saved: false });
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(() => dispatch(form));
  };
  return (
    <form onSubmit={onSubmit} className={styles.form}>
      {children}
      <div className={styles.actions}>
        <button type="submit" disabled={pending}>
          {submit}
        </button>
        {state.error ? (
          <p role="alert" className={styles.error}>
            {state.error}
          </p>
        ) : (
          <p role="status" className={styles.status}>
            {state.saved && !pending ? "Saved." : ""}
          </p>
        )}
      </div>
    </form>
  );
}
