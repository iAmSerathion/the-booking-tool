# the-booking-tool

A self-hostable booking tool for a team. Members sign in with Google, connect their Google Calendar, and invitees book
free times on public booking pages, through booking links or in widgets embedded on your website. Every booking becomes
a Google Calendar event, with a Meet link when the member switches Meet on.

Status: pre-release (version 0.0.0). Expect changes before a first tagged release.

## Features

- **Google sign-in** through Supabase Auth; access by invitation, by Google Workspace domain, and a first admin from
  `INITIAL_ADMIN_EMAIL`.
- **Google Calendar availability:** times come from each member's availability windows, buffers, minimum notice and
  daily maximum, minus their Google busy times. Bookings create Google events, with Meet when the member switches it on.
- **Booking pages:** a general page at `/` (one member or round robin) and a page per member at `/<slug>`.
- **Widgets** for other websites, as a dialog or an inline section, for one member or round robin over chosen members,
  pinned to the sites allowed to embed them.
- **Booking links** (`/l/<token>`) with a fixed host and event type, prefill, metadata, single use and expiry.
- **Event types** with duration and up to 20 booking questions.
- **Reschedule and cancel links** for invitees, plus "book a new time" after a cancel.
- **Mail over SMTP:** confirmations, change notices and reminders (24 hours and 1 hour before, configurable), retried
  with backoff.
- **Calendar sync:** moving or deleting the Google event, or the invitee declining, updates the booking.
- **Signed webhooks** for every booking change (HMAC-SHA256, at least once, in order per booking).
- **Admin:** bookings, links, widgets, event types, team (invite, roles, deactivate with handover) and a widget
  playground.

### Limits of v1

- Google only: Google sign-in and Google Calendar. No Outlook, CalDAV or password login.
- One team per instance; no multi-tenancy.
- Supabase is required (Postgres, Auth, Vault). Plain Postgres is not supported.
- Interface and mails in German and English (`DEFAULT_LOCALE`, default `de`).
- SMTP only for mail. No Dockerfile is provided.

## Stack

Next.js (App Router) on Node 24, Supabase (Postgres, Auth, Vault), Google Calendar and Meet, SMTP (nodemailer).

## Quick start (local development)

Requirements: Node 24+ and Docker.

```bash
npm ci
npm run stack:up             # local Supabase on 127.0.0.1, writes .env.e2e.local
# create .env.local: copy the minimal block from CONTRIBUTING.md and paste in the two keys from .env.e2e.local
node tests/e2e/google-fake.mjs   # terminal 1: stands in for Google Calendar
node tests/e2e/smtp-sink.mjs     # terminal 2: catches the mails
npm run dev                      # terminal 3: http://127.0.0.1:3000 (bound to 127.0.0.1 only)
npm run dev:calendar             # connects the seeded host to the Google fake
npm run dev:login                # prints a one-time URL that signs you in to /app as the seeded admin
npm run stack:down               # stop the stack and delete its data
```

The minimal `.env.local` is in [CONTRIBUTING.md](CONTRIBUTING.md#local-development). The stack seeds example members
(`admin.demo@example.com`, `host.demo@example.com`), an event type and a widget. With the steps above you can book a
time on `http://127.0.0.1:3000/demo-host` and open the admin without a Google OAuth client; details in
[Try it without Google](CONTRIBUTING.md#try-it-without-google). `npm run dev:calendar` and `npm run dev:login` refuse a
Supabase that is not on this machine. Signing in with Google by hand needs a real Google OAuth client:
[Signing in locally](CONTRIBUTING.md#signing-in-locally).

Run the checks with `npm run lint`, `npm run typecheck` and `npm test`; the database and end-to-end tests are in
[CONTRIBUTING.md](CONTRIBUTING.md#checks).

## Documentation

- [SELF-HOSTING.md](SELF-HOSTING.md): Google Cloud, Supabase, environment variables, the scheduler, deployment,
  upgrades and troubleshooting.
- [docs/features.md](docs/features.md): how sign-in, booking pages, links, widgets, event types, the team, mail,
  reminders and calendar sync behave.
- [docs/embedding.md](docs/embedding.md): embedding widgets on your website.
- [docs/webhooks.md](docs/webhooks.md): webhook events, payload, signature and delivery.
- [SECURITY.md](SECURITY.md): reporting vulnerabilities and the security model.
- [CONTRIBUTING.md](CONTRIBUTING.md): development setup, checks and conventions.

## Webhooks

Set `WEBHOOK_URL` and `WEBHOOK_SECRET` and every booking change (`booking.created`, `booking.rescheduled`,
`booking.cancelled`, `booking.host_changed`) is POSTed there as signed JSON. Payload, signature check, retries and
replay protection: [docs/webhooks.md](docs/webhooks.md).

## License

[AGPL-3.0-only](LICENSE). Contributions are accepted under the same license; see [CONTRIBUTING.md](CONTRIBUTING.md).
