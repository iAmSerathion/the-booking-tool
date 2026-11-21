"use client";

import { type FormEvent, startTransition, useActionState, useState, useSyncExternalStore } from "react";
import type { LinkFormOptions } from "@/lib/links/data";
import { type CreateLinkState, createLink } from "@/lib/links/actions";
import styles from "../settings/settings.module.css";

const metaRows = 5;

// The "new link" form. The event type decides which questions can be prefilled. After saving, the link is shown once
// with a copy button: only its hash is stored. Submitting through onSubmit keeps what was typed when the server refuses.
export function CreateLinkForm({ eventTypes, hosts }: LinkFormOptions) {
  const [state, dispatch, pending] = useActionState(createLink, { error: null, saved: false, url: null } as CreateLinkState);
  const [typeId, setTypeId] = useState(eventTypes[0]?.id ?? "");
  const [copied, setCopied] = useState(false);
  // Like ActionForm: a click before hydration would be a GET submit that puts the invitee's details in the URL.
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  const questions = eventTypes.find((t) => t.id === typeId)?.questions ?? [];

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setCopied(false);
    startTransition(() => dispatch(form));
  };
  const copy = async () => {
    if (!state.url) return;
    await navigator.clipboard.writeText(state.url).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <form onSubmit={onSubmit} className={styles.form}>
      <div className={styles.field}>
        <label htmlFor="link-event-type">Event type</label>
        <select id="link-event-type" name="event_type_id" value={typeId} onChange={(e) => setTypeId(e.target.value)} required>
          {eventTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      </div>
      {hosts.length > 0 && (
        <div className={styles.field}>
          <label htmlFor="link-host">Host</label>
          <select id="link-host" name="host_id" defaultValue="">
            <option value="">Me</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <fieldset className={styles.form}>
        <legend>Prefill (optional, the invitee can change it)</legend>
        {(["name", "email", "company"] as const).map((name) => (
          <div key={name} className={styles.field}>
            <label htmlFor={`link-${name}`}>{{ name: "Name", email: "Email", company: "Company" }[name]}</label>
            <input id={`link-${name}`} name={name} type={name === "email" ? "email" : "text"} autoComplete="off" />
          </div>
        ))}
        {questions.map((q) =>
          q.type === "text" ? (
            <div key={q.id} className={styles.field}>
              <label htmlFor={`link-answer-${q.id}`}>{q.label}</label>
              <textarea id={`link-answer-${q.id}`} name={`answer.${q.id}`} rows={2} />
            </div>
          ) : q.type === "choice" ? (
            <div key={q.id} className={styles.field}>
              <label htmlFor={`link-answer-${q.id}`}>{q.label}</label>
              <select id={`link-answer-${q.id}`} name={`answer.${q.id}`} defaultValue="">
                <option value="">No prefill</option>
                {(q.choices ?? []).map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
          ) : (
            <fieldset key={q.id} className={styles.field}>
              <legend>{q.label}</legend>
              {(q.choices ?? []).map((c) => (
                <label key={c}>
                  <input type="checkbox" name={`answer.${q.id}`} value={c} /> {c}
                </label>
              ))}
            </fieldset>
          ),
        )}
      </fieldset>

      <label>
        <input type="checkbox" name="single_use" defaultChecked /> Single use: closes after one booking
      </label>
      <div className={styles.field}>
        <label htmlFor="link-expires">Expires after (days, empty for never)</label>
        <input id="link-expires" name="expires_days" type="number" min={1} max={365} step={1} inputMode="numeric" />
      </div>

      <fieldset className={styles.form}>
        <legend>Metadata (optional, passed to webhooks, never shown to the invitee)</legend>
        {Array.from({ length: metaRows }, (_, i) => (
          <div key={i} className={styles.pair}>
            <input name="meta_key" aria-label={`Metadata key ${i + 1}`} placeholder="key" autoComplete="off" />
            <input name="meta_value" aria-label={`Metadata value ${i + 1}`} placeholder="value" autoComplete="off" />
          </div>
        ))}
      </fieldset>

      <div className={styles.actions}>
        <button type="submit" disabled={pending || !typeId || !hydrated}>
          Create link
        </button>
        {state.error && (
          <p role="alert" className={styles.error}>
            {state.error}
          </p>
        )}
      </div>
      {state.url && !pending && (
        <div className={styles.field}>
          <label htmlFor="new-link">New booking link</label>
          <input id="new-link" className={styles.link} readOnly value={state.url} onFocus={(e) => e.target.select()} />
          <div className={styles.actions}>
            <button type="button" onClick={copy}>
              Copy link
            </button>
            <p role="status" className={styles.status}>
              {copied ? "Copied." : ""}
            </p>
          </div>
          <p className={styles.hint}>Shown only now: only a hash of the link is stored, so it cannot be shown again.</p>
        </div>
      )}
    </form>
  );
}

const noSubscribe = () => () => {};
