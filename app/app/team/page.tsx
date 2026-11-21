import { currentProfile } from "@/lib/auth/profile";
import { getConfig } from "@/lib/config";
import { bookingLink } from "@/lib/core/settings";
import { slugMaxLength } from "@/lib/core/team";
import { inviteMember, reactivateMember, setMemberRight, setMemberSlug, setWebsiteBookings } from "@/lib/team/actions";
import { loadTeam, type TeamMember, type WebsiteSetting } from "@/lib/team/data";
import { ActionForm } from "../settings/action-form";
import styles from "../settings/settings.module.css";

// The team. Members see who is in it and their booking links; admins also change rights and link names, invite,
// reactivate and choose who gets website bookings (the actions and the database check that again).
export default async function TeamPage() {
  const me = await currentProfile();
  const { members, website } = await loadTeam();
  const { appUrl } = getConfig();
  const shown = me.is_admin ? members : members.filter((m) => m.active);
  return (
    <>
      <h1>Team</h1>
      <section aria-labelledby="members-heading" className={styles.section}>
        <h2 id="members-heading">Members</h2>
        {me.is_admin && <p className={styles.hint}>At least one active member must stay an admin. Bookable members can be booked once their calendar is connected.</p>}
        <ul className={styles.cards}>
          {shown.map((member) => (
            <li key={member.id} className={styles.card} aria-label={member.name}>
              <h3>
                {member.name}
                {member.id === me.id && " (you)"}
              </h3>
              <MemberFacts member={member} appUrl={appUrl} />
              {me.is_admin && <MemberControls member={member} appUrl={appUrl} />}
            </li>
          ))}
        </ul>
      </section>

      {me.is_admin && (
        <>
          <section aria-labelledby="invite-heading" className={styles.section}>
            <h2 id="invite-heading">Invite a member</h2>
            <ActionForm action={inviteMember} submit="Invite">
              <InviteFields />
            </ActionForm>
          </section>
          <section aria-labelledby="website-heading" className={styles.section}>
            <h2 id="website-heading">Website bookings</h2>
            <WebsiteForm website={website} members={members.filter((m) => m.active && m.bookable)} />
          </section>
        </>
      )}
    </>
  );
}

function MemberFacts({ member, appUrl }: { member: TeamMember; appUrl: string }) {
  const link = bookingLink(appUrl, member.slug);
  return (
    <dl className={styles.pairs}>
      <dt>Email</dt>
      <dd>{member.email}</dd>
      <dt>Role</dt>
      <dd>{member.is_admin ? "Admin" : "Member"}</dd>
      <dt>Bookable</dt>
      <dd>{member.bookable ? "Yes" : "No"}</dd>
      <dt>Booking page</dt>
      <dd className={styles.link}>{link ? <a href={link}>{link}</a> : "None"}</dd>
      {!member.active && (
        <>
          <dt>Status</dt>
          <dd>Deactivated</dd>
        </>
      )}
    </dl>
  );
}

function MemberControls({ member, appUrl }: { member: TeamMember; appUrl: string }) {
  if (!member.active) {
    return (
      <ActionForm action={reactivateMember} submit="Reactivate">
        <input type="hidden" name="profile_id" value={member.id} />
      </ActionForm>
    );
  }
  return (
    <>
      <ActionForm action={setMemberRight} submit={member.is_admin ? "Remove admin" : "Make admin"}>
        <input type="hidden" name="profile_id" value={member.id} />
        <input type="hidden" name="right" value="is_admin" />
        <input type="hidden" name="on" value={String(!member.is_admin)} />
      </ActionForm>
      <ActionForm action={setMemberRight} submit={member.bookable ? "Make not bookable" : "Make bookable"}>
        <input type="hidden" name="profile_id" value={member.id} />
        <input type="hidden" name="right" value="bookable" />
        <input type="hidden" name="on" value={String(!member.bookable)} />
      </ActionForm>
      <details>
        <summary>Change link name</summary>
        <ActionForm action={setMemberSlug} submit="Save link name">
          <input type="hidden" name="profile_id" value={member.id} />
          <div className={styles.field}>
            <label htmlFor={`${member.id}-slug`}>Link name</label>
            <input
              id={`${member.id}-slug`}
              name="slug"
              required
              maxLength={slugMaxLength}
              defaultValue={member.slug ?? ""}
              aria-describedby={`${member.id}-slug-hint`}
              autoComplete="off"
              spellCheck={false}
            />
            <p id={`${member.id}-slug-hint`} className={styles.hint}>
              The booking page becomes {appUrl}/&lt;link name&gt;. Lowercase letters, digits and dashes. The old link stops
              working.
            </p>
          </div>
        </ActionForm>
      </details>
    </>
  );
}

function InviteFields() {
  return (
    <>
      <div className={styles.field}>
        <label htmlFor="invite-name">Name</label>
        <input id="invite-name" name="name" required maxLength={200} autoComplete="off" />
      </div>
      <div className={styles.field}>
        <label htmlFor="invite-email">Google account email</label>
        <input id="invite-email" name="email" type="email" required maxLength={254} autoComplete="off" aria-describedby="invite-email-hint" />
        <p id="invite-email-hint" className={styles.hint}>
          They sign in with this Google account. No email is sent; tell them yourself.
        </p>
      </div>
      <div className={styles.field}>
        <label htmlFor="invite-slug">Link name</label>
        <input id="invite-slug" name="slug" maxLength={slugMaxLength} autoComplete="off" spellCheck={false} aria-describedby="invite-slug-hint" />
        <p id="invite-slug-hint" className={styles.hint}>
          For their booking page. Leave empty to make one from the name.
        </p>
      </div>
      <label>
        <input type="checkbox" name="is_admin" /> Admin
      </label>
      <label>
        <input type="checkbox" name="bookable" aria-describedby="invite-bookable-hint" /> Bookable
      </label>
      <p id="invite-bookable-hint" className={styles.hint}>
        Usually turned on after they have connected their calendar.
      </p>
    </>
  );
}

function WebsiteForm({ website, members }: { website: WebsiteSetting; members: TeamMember[] }) {
  return (
    <ActionForm action={setWebsiteBookings} submit="Save website bookings">
      <p className={styles.hint}>Who gets the bookings from the general booking page.</p>
      <fieldset className={styles.field}>
        <legend>Bookings go to</legend>
        <label>
          <input type="radio" name="mode" value="round_robin" defaultChecked={website.mode === "round_robin"} /> Round robin over all bookable members
        </label>
        <label>
          <input type="radio" name="mode" value="person" defaultChecked={website.mode === "person"} /> One person
        </label>
      </fieldset>
      <div className={styles.field}>
        <label htmlFor="website-person">Person</label>
        <select id="website-person" name="person_id" defaultValue={website.personId ?? ""}>
          <option value="">Choose a bookable member</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
    </ActionForm>
  );
}
