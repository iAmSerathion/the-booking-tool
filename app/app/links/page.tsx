import { currentProfile } from "@/lib/auth/profile";
import { linkStatus } from "@/lib/core/links";
import { revokeLink } from "@/lib/links/actions";
import { loadLinkFormOptions, loadLinks } from "@/lib/links/data";
import { ActionForm } from "../settings/action-form";
import styles from "../settings/settings.module.css";
import { CreateLinkForm } from "./create-link-form";

const statusText = { active: "Active", used: "Used", expired: "Expired", revoked: "Revoked" } as const;
const date = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(iso));
const text = (value: unknown) => (typeof value === "string" ? value : "");

// Booking links: one invitee, a fixed host and event type, optional prefill and metadata. Members see and create their
// own links; admins all, for any bookable host.
export default async function LinksPage() {
  const me = await currentProfile();
  const [links, options] = await Promise.all([loadLinks(), loadLinkFormOptions(me.is_admin)]);
  const now = new Date();
  return (
    <>
      <h1>Links</h1>
      <p>A booking link opens the booking page for one host and event type, with the invitee&apos;s details already filled in.</p>

      <section aria-labelledby="new-link-heading" className={styles.section}>
        <h2 id="new-link-heading">New link</h2>
        {options.eventTypes.length ? <CreateLinkForm {...options} /> : <p>There is no active event type.</p>}
      </section>

      <section aria-labelledby="links-heading" className={styles.section}>
        <h2 id="links-heading">{me.is_admin ? "All links" : "Your links"}</h2>
        {links.length === 0 && <p>No links yet.</p>}
        <ul className={styles.cards}>
          {links.map((link) => {
            const status = linkStatus(link, now);
            const label = [text(link.prefill.name) || text(link.prefill.email) || "Link", link.eventType, date(link.created_at, me.timezone)].join(", ");
            const meta = Object.entries(link.metadata).sort(([a], [b]) => a.localeCompare(b));
            return (
              <li key={link.id} className={styles.card} aria-label={label}>
                <dl className={styles.pairs}>
                  <dt>For</dt>
                  <dd>{[text(link.prefill.name), text(link.prefill.email)].filter(Boolean).join(" · ") || "Anyone"}</dd>
                  <dt>Event type</dt>
                  <dd>{link.eventType}</dd>
                  {me.is_admin && (
                    <>
                      <dt>Host</dt>
                      <dd>{link.host}</dd>
                    </>
                  )}
                  <dt>Created</dt>
                  <dd>{date(link.created_at, me.timezone)}</dd>
                  <dt>Use</dt>
                  <dd>
                    {link.single_use ? "Single use" : "Reusable"}
                    {link.expires_at && `, expires ${date(link.expires_at, me.timezone)}`}
                  </dd>
                  <dt>Status</dt>
                  <dd>{statusText[status]}</dd>
                  {meta.length > 0 && (
                    <>
                      <dt>Metadata</dt>
                      <dd className={styles.link}>{meta.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ")}</dd>
                    </>
                  )}
                </dl>
                {status === "active" && (
                  <ActionForm action={revokeLink} submit="Revoke">
                    <input type="hidden" name="link_id" value={link.id} />
                  </ActionForm>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
