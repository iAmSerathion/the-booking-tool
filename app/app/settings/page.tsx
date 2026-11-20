import { Fragment } from "react";
import { currentProfile } from "@/lib/auth/profile";
import { getConfig } from "@/lib/config";
import { bookingLink, formatWindows, ruleLimits, timeZones, weekdays } from "@/lib/core/settings";
import { googleNotice } from "@/lib/google/notices";
import { disconnectCalendar, saveAvailability, saveRules, setBusyCalendars } from "@/lib/settings/actions";
import { type CalendarConnection, loadAccount, loadCalendarConnection } from "@/lib/settings/data";
import { ActionForm } from "./action-form";
import styles from "./settings.module.css";

export default async function SettingsPage({ searchParams }: PageProps<"/app/settings">) {
  const me = await currentProfile();
  const notice = googleNotice((await searchParams).google);
  const [calendar, account] = await Promise.all([loadCalendarConnection(me.id), loadAccount(me.id)]);
  const link = bookingLink(getConfig().appUrl, account.slug);
  const zones = timeZones();
  if (!zones.includes(account.timezone)) zones.unshift(account.timezone);
  return (
    <>
      <h1>Settings</h1>
      <p>Signed in as {me.email}</p>

      <section aria-labelledby="calendar-heading" className={styles.section}>
        <h2 id="calendar-heading">Google Calendar</h2>
        {notice && <p role="alert">{notice}</p>}
        {calendar ? (
          <Connected calendar={calendar} />
        ) : (
          <>
            <p>Not connected. Connect your calendar so bookings avoid your busy times and land in your calendar.</p>
            {/* A plain link: the route redirects to Google, which a client-side navigation cannot follow. */}
            <a href="/api/google/connect">Connect Google Calendar</a>
          </>
        )}
      </section>

      <section aria-labelledby="availability-heading" className={styles.section}>
        <h2 id="availability-heading">Availability</h2>
        <ActionForm action={saveAvailability} submit="Save availability">
          <p id="windows-hint" className={styles.hint}>
            Times you can be booked, in your time zone, on the half hour, for example 09:00-12:00, 14:00-17:00. Leave a day
            empty if you cannot be booked that day.
          </p>
          <fieldset className={styles.week}>
            <legend className={styles.hint}>Weekly hours</legend>
            {weekdays.map((name, index) => (
              <Fragment key={name}>
                <label htmlFor={`day-${index + 1}`}>{name}</label>
                <input
                  id={`day-${index + 1}`}
                  name={`day-${index + 1}`}
                  defaultValue={formatWindows(account.days[index])}
                  aria-describedby="windows-hint"
                  autoComplete="off"
                />
              </Fragment>
            ))}
          </fieldset>
        </ActionForm>
      </section>

      <section aria-labelledby="rules-heading" className={styles.section}>
        <h2 id="rules-heading">Booking rules</h2>
        <ActionForm action={saveRules} submit="Save booking rules">
          <div className={styles.field}>
            <label htmlFor="timezone">Time zone</label>
            <select id="timezone" name="timezone" defaultValue={account.timezone}>
              {zones.map((zone) => (
                <option key={zone}>{zone}</option>
              ))}
            </select>
          </div>
          <NumberField name="buffer_minutes" unit="minutes" value={account.buffer_minutes} />
          <NumberField name="min_notice_hours" unit="hours" value={account.min_notice_hours} />
          <NumberField name="max_bookings_per_day" value={account.max_bookings_per_day} />
          <label>
            <input type="checkbox" name="meet_auto" defaultChecked={account.meet_auto} /> Add a Google Meet link to new bookings
          </label>
        </ActionForm>
      </section>

      <section aria-labelledby="link-heading" className={styles.section}>
        <h2 id="link-heading">Booking link</h2>
        {link ? (
          <p>
            Your booking page:{" "}
            <a href={link} className={styles.link}>
              {link}
            </a>
          </p>
        ) : (
          <p>You have no booking link yet. An admin sets it under Team.</p>
        )}
      </section>
    </>
  );
}

function NumberField({ name, unit, value }: { name: keyof typeof ruleLimits; unit?: string; value: number }) {
  const { min, max, label } = ruleLimits[name];
  return (
    <div className={styles.field}>
      <label htmlFor={name}>
        {label}
        {unit && ` (${unit})`}
      </label>
      <input id={name} name={name} type="number" inputMode="numeric" min={min} max={max} step={1} required defaultValue={value} aria-describedby={`${name}-range`} />
      <p id={`${name}-range`} className={styles.hint}>
        {min} to {max}
      </p>
    </div>
  );
}

function Connected({ calendar }: { calendar: CalendarConnection }) {
  return (
    <>
      {calendar.needsReconnect ? (
        <p>
          <strong>Reconnect needed:</strong> Google no longer accepts the connection with {calendar.accountEmail}.{" "}
          <a href="/api/google/connect">Reconnect Google Calendar</a>
        </p>
      ) : (
        <p>Connected with {calendar.accountEmail}</p>
      )}
      <ActionForm action={disconnectCalendar} submit="Disconnect" />

      <h3>Busy calendars</h3>
      {calendar.calendars ? (
        <ActionForm action={setBusyCalendars} submit="Save busy calendars">
          <p className={styles.hint}>Events in these calendars block booking slots. New bookings always go into your primary calendar.</p>
          {calendar.calendars.map((entry) => (
            <div key={entry.id}>
              <label>
                <input
                  type="checkbox"
                  name="calendar"
                  value={entry.id}
                  defaultChecked={entry.primary || calendar.busyCalendarIds.includes(entry.id)}
                  disabled={entry.primary}
                />{" "}
                {entry.name}
                {entry.primary && " (primary calendar)"}
              </label>
            </div>
          ))}
        </ActionForm>
      ) : (
        <p>Your calendars cannot be loaded from Google right now. Your saved choice is kept.</p>
      )}
    </>
  );
}
