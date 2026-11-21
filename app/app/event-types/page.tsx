import { notFound } from "next/navigation";
import { currentProfile } from "@/lib/auth/profile";
import { getConfig } from "@/lib/config";
import { saveEventType, setDefaultEventType, setEventTypeActive } from "@/lib/event-types/actions";
import { type EventTypeRow, listEventTypes } from "@/lib/event-types/data";
import { ActionForm } from "../settings/action-form";
import styles from "../settings/settings.module.css";
import { QuestionsField } from "./questions-field";

// What invitees can book: title, link name, duration and booking questions. The default event type is what "/" and
// "/<member>" book without ?type=. Admins only; members get the 404 page (the RPCs refuse them too).
export default async function EventTypesPage() {
  const me = await currentProfile();
  if (!me.is_admin) notFound();
  const { eventTypes, defaultId } = await listEventTypes();
  const { appUrl } = getConfig();
  return (
    <>
      <h1>Event types</h1>
      <p>
        The booking pages offer every event type that is on, the default one first. A type can be opened directly with
        ?type=&lt;link name&gt;, on the general page and on each member&apos;s page. Switching a type off also closes its
        widgets and booking links.
      </p>

      <section aria-labelledby="new-type-heading" className={styles.section}>
        <h2 id="new-type-heading">New event type</h2>
        <ActionForm action={saveEventType} submit="Create event type">
          {/* Keyed by the count, so the fields start empty again after a type was created (the status line stays). */}
          <EventTypeFields key={eventTypes.length} prefix="new" />
        </ActionForm>
      </section>

      <section aria-labelledby="types-heading" className={styles.section}>
        <h2 id="types-heading">All event types</h2>
        <ul className={styles.cards}>
          {eventTypes.map((type) => {
            const isDefault = type.id === defaultId;
            return (
              <li key={type.id} className={styles.card} aria-label={type.title}>
                <h3>{type.title}</h3>
                <dl className={styles.pairs}>
                  <dt>Status</dt>
                  <dd>{(type.active ? "On" : "Off") + (isDefault ? " · Default" : "")}</dd>
                  <dt>Duration</dt>
                  <dd>{type.duration_minutes} minutes</dd>
                  <dt>Link</dt>
                  <dd className={styles.link}>{`${appUrl}/?type=${type.slug}`}</dd>
                  <dt>Questions</dt>
                  <dd>{type.questions.map((q) => q.label + (q.required ? " (required)" : "")).join(", ") || "None"}</dd>
                </dl>
                {isDefault ? (
                  <p className={styles.hint}>The default event type cannot be switched off. Make another type the default first.</p>
                ) : (
                  <>
                    <ActionForm action={setEventTypeActive} submit={type.active ? `Switch off ${type.title}` : `Switch on ${type.title}`}>
                      <input type="hidden" name="event_type_id" value={type.id} />
                      <input type="hidden" name="active" value={String(!type.active)} />
                    </ActionForm>
                    {type.active && (
                      <ActionForm action={setDefaultEventType} submit={`Make ${type.title} the default`}>
                        <input type="hidden" name="event_type_id" value={type.id} />
                      </ActionForm>
                    )}
                  </>
                )}
                <details>
                  <summary>Edit</summary>
                  <ActionForm action={saveEventType} submit="Save event type">
                    <input type="hidden" name="event_type_id" value={type.id} />
                    <EventTypeFields prefix={type.id} type={type} />
                  </ActionForm>
                </details>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

// The fields of the new and the edit form; prefix keeps the label ids unique on the page.
function EventTypeFields({ prefix, type }: { prefix: string; type?: EventTypeRow }) {
  return (
    <>
      <div className={styles.field}>
        <label htmlFor={`${prefix}-title`}>Title</label>
        <input id={`${prefix}-title`} name="title" maxLength={120} required defaultValue={type?.title} autoComplete="off" />
      </div>
      <div className={styles.field}>
        <label htmlFor={`${prefix}-slug`}>Link name</label>
        <input
          id={`${prefix}-slug`}
          name="slug"
          maxLength={60}
          required
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          defaultValue={type?.slug}
          aria-describedby={`${prefix}-slug-hint`}
          autoComplete="off"
          spellCheck={false}
        />
        <p id={`${prefix}-slug-hint`} className={styles.hint}>
          Lowercase letters, digits and single dashes.{type && " Changing it breaks shared ?type= links."}
        </p>
      </div>
      <div className={styles.field}>
        <label htmlFor={`${prefix}-description`}>Description</label>
        <textarea id={`${prefix}-description`} name="description" rows={2} maxLength={2000} defaultValue={type?.description ?? ""} />
      </div>
      <div className={styles.field}>
        <label htmlFor={`${prefix}-duration`}>Duration in minutes</label>
        <input id={`${prefix}-duration`} name="duration_minutes" type="number" min={5} max={480} step={5} required defaultValue={type?.duration_minutes ?? 30} />
      </div>
      {/* Keyed by the saved questions, so new questions show the ids the server gave them after a save. */}
      <QuestionsField key={JSON.stringify(type?.questions ?? [])} prefix={prefix} initial={type?.questions ?? []} />
    </>
  );
}
