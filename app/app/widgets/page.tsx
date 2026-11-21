import Link from "next/link";
import { notFound } from "next/navigation";
import { currentProfile } from "@/lib/auth/profile";
import { getConfig } from "@/lib/config";
import { widgetSnippets } from "@/lib/core/widget";
import { type LinkFormOptions, loadLinkFormOptions } from "@/lib/links/data";
import { saveWidget, setWidgetActive } from "@/lib/widget/actions";
import { listWidgets, type WidgetListItem } from "@/lib/widget/data";
import { ActionForm } from "../settings/action-form";
import styles from "../settings/settings.module.css";
import { CopySnippet } from "./copy-snippet";

// Booking widgets for other websites: who gets the bookings, which event type, and which sites may embed it. Admins
// only; members get the 404 page (the RPCs refuse them too).
export default async function WidgetsPage() {
  const me = await currentProfile();
  if (!me.is_admin) notFound();
  const [widgets, options] = await Promise.all([listWidgets(), loadLinkFormOptions(true)]);
  const { appUrl, locale } = getConfig();
  return (
    <>
      <h1>Widgets</h1>
      <p>
        A widget puts booking on another website, as a window over the page or as a section in it. Only the sites listed
        under &quot;Allowed sites&quot; can embed it. Try a widget in the <Link href="/app/playground">playground</Link>; the
        snippets are explained in docs/embedding.md.
      </p>

      <section aria-labelledby="new-widget-heading" className={styles.section}>
        <h2 id="new-widget-heading">New widget</h2>
        {options.eventTypes.length && options.hosts.length ? (
          <ActionForm action={saveWidget} submit="Create widget">
            <WidgetFields prefix="new" options={options} />
          </ActionForm>
        ) : (
          <p>A widget needs an active event type and a bookable member.</p>
        )}
      </section>

      <section aria-labelledby="widgets-heading" className={styles.section}>
        <h2 id="widgets-heading">All widgets</h2>
        {widgets.length === 0 && <p>No widgets yet.</p>}
        <ul className={styles.cards}>
          {widgets.map((widget) => {
            const snippets = widgetSnippets(appUrl, widget.id, locale);
            return (
              <li key={widget.id} className={styles.card} aria-label={widget.name}>
                <h3>{widget.name}</h3>
                <dl className={styles.pairs}>
                  <dt>Status</dt>
                  <dd>{widget.active ? "On" : "Off"}</dd>
                  <dt>Bookings go to</dt>
                  <dd>{(widget.mode === "person" ? "" : "Round robin: ") + widget.hosts.map((h) => h.name).join(", ")}</dd>
                  <dt>Event type</dt>
                  <dd>{widget.eventType}</dd>
                  <dt>Allowed sites</dt>
                  <dd>{widget.allowed_origins.join(", ") || "None of its own (EMBED_ALLOWED_ORIGINS applies)"}</dd>
                  <dt>ID</dt>
                  <dd>{widget.id}</dd>
                </dl>
                <ActionForm action={setWidgetActive} submit={widget.active ? `Switch off ${widget.name}` : `Switch on ${widget.name}`}>
                  <input type="hidden" name="widget_id" value={widget.id} />
                  <input type="hidden" name="active" value={String(!widget.active)} />
                </ActionForm>
                <details>
                  <summary>Edit</summary>
                  <ActionForm action={saveWidget} submit="Save widget">
                    <input type="hidden" name="widget_id" value={widget.id} />
                    <WidgetFields prefix={widget.id} options={options} widget={widget} />
                  </ActionForm>
                </details>
                <details>
                  <summary>Embed code</summary>
                  <CopySnippet label="Window snippet" code={snippets.window} />
                  <CopySnippet label="Section snippet" code={snippets.section} />
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
function WidgetFields({ prefix, options, widget }: { prefix: string; options: LinkFormOptions; widget?: WidgetListItem }) {
  const hosts = new Set(widget?.hosts.map((h) => h.id));
  return (
    <>
      <div className={styles.field}>
        <label htmlFor={`${prefix}-name`}>Name</label>
        <input id={`${prefix}-name`} name="name" maxLength={80} required defaultValue={widget?.name} autoComplete="off" />
      </div>
      <div className={styles.field}>
        <label htmlFor={`${prefix}-event-type`}>Event type</label>
        <select id={`${prefix}-event-type`} name="event_type_id" defaultValue={widget?.event_type_id}>
          {options.eventTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      </div>
      <fieldset className={styles.field}>
        <legend>Bookings go to</legend>
        <label>
          <input type="radio" name="mode" value="person" defaultChecked={(widget?.mode ?? "person") === "person"} /> One person (choose exactly one below)
        </label>
        <label>
          <input type="radio" name="mode" value="round_robin" defaultChecked={widget?.mode === "round_robin"} /> Round robin over the people chosen below
        </label>
      </fieldset>
      <fieldset className={styles.field}>
        <legend>People</legend>
        {options.hosts.map((h) => (
          <label key={h.id}>
            <input type="checkbox" name="host_id" value={h.id} defaultChecked={hosts.has(h.id)} /> {h.name}
          </label>
        ))}
      </fieldset>
      <div className={styles.field}>
        <label htmlFor={`${prefix}-origins`}>Allowed sites</label>
        <textarea
          id={`${prefix}-origins`}
          name="allowed_origins"
          rows={3}
          defaultValue={widget?.allowed_origins.join("\n")}
          aria-describedby={`${prefix}-origins-hint`}
          autoComplete="off"
          spellCheck={false}
        />
        <p id={`${prefix}-origins-hint`} className={styles.hint}>
          One origin per line, such as https://www.example.com: no path, https only (http only for localhost). At most 20.
        </p>
      </div>
    </>
  );
}
