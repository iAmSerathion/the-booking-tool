import { currentProfile } from "@/lib/auth/profile";
import { googleNotice } from "@/lib/google/notices";
import { disconnectCalendar, setBusyCalendars } from "@/lib/settings/actions";
import { type CalendarConnection, loadCalendarConnection } from "@/lib/settings/data";

// shortcut: availability windows and booking rules join this page later in M3.
export default async function SettingsPage({ searchParams }: PageProps<"/app/settings">) {
  const me = await currentProfile();
  const notice = googleNotice((await searchParams).google);
  const calendar = await loadCalendarConnection(me.id);
  return (
    <>
      <h1>Settings</h1>
      <p>Signed in as {me.email}</p>
      <section aria-labelledby="calendar-heading">
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
    </>
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
      <form action={disconnectCalendar}>
        <button type="submit">Disconnect</button>
      </form>

      <h3>Busy calendars</h3>
      {calendar.calendars ? (
        <form action={setBusyCalendars}>
          <p>Events in these calendars block booking slots. New bookings always go into your primary calendar.</p>
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
          <button type="submit">Save busy calendars</button>
        </form>
      ) : (
        <p>Your calendars cannot be loaded from Google right now. Your saved choice is kept.</p>
      )}
    </>
  );
}
