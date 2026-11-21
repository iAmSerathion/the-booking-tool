"use client";

import { type FormEvent, type ReactNode, startTransition, useActionState, useSyncExternalStore } from "react";
import type { ActionState } from "@/lib/settings/actions";
import styles from "./settings.module.css";

// A settings form with its result shown inline next to the button. Submitting through onSubmit (not the action prop)
// keeps what the member typed when the server refuses it; React would otherwise reset the form. Until hydration the
// button stays disabled: a click before then would be a plain GET submit that reloads the page and drops the input.
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
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(() => dispatch(form));
  };
  return (
    <form onSubmit={onSubmit} className={styles.form}>
      {children}
      <div className={styles.actions}>
        <button type="submit" disabled={pending || !hydrated}>
          {submit}
        </button>
        {state.error ? (
          <p role="alert" className={styles.error}>
            {state.error}
          </p>
        ) : (
          <p role="status" className={styles.status}>
            {state.saved && !pending ? (state.message ?? "Saved.") : ""}
          </p>
        )}
      </div>
    </form>
  );
}

const noSubscribe = () => () => {};
