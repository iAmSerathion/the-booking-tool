# the-booking-tool

A self-hostable booking tool: connect your Google Calendar, share booking pages and personal links, and embed booking widgets on your website.

Work in progress. Not ready for use yet.

## Stack

Next.js (App Router), Supabase (Postgres, Auth, Vault), Google Calendar and Meet, SMTP for mail.

## Local development

Requirements: Node 24+ and Docker.

```bash
npm install
npm run stack:up             # local Supabase on 127.0.0.1, writes .env.e2e.local
cp .env.example .env.local   # fill in the values; Supabase URL and keys are in .env.e2e.local
npm run dev
npm run stack:down           # stop it and delete its data
```

`npm run stack:up` starts Postgres, GoTrue (auth), PostgREST and a Kong gateway with docker compose
(`scripts/stack/`), always from scratch: it applies `supabase/migrations` and `supabase/seed.sql` and generates new
keys each time. The API listens on `127.0.0.1:54421`, Postgres on `127.0.0.1:54422`. Every port is bound to
127.0.0.1 only; `supabase start` would publish on all interfaces. `supabase/config.toml` uses the same ports for CI.

Seeded members: `admin.demo@example.com` (admin) and `host.demo@example.com` (bookable). Login is Google only. The
e2e tests sign in with generated magic-link sessions (`tests/e2e/session.ts`). By default the stack carries a fake Google
client, so "Sign in with Google" in `npm run dev` fails at Google. To sign in by hand, create a Google OAuth web client
with the redirect URI `http://127.0.0.1:54421/auth/v1/callback`, then start the stack with it:

```bash
GOOGLE_CLIENT_ID=<client id> GOOGLE_CLIENT_SECRET=<client secret> npm run stack:up
```

Put the same two values and the Supabase keys from `.env.e2e.local` into `.env.local`. Sign in with `INITIAL_ADMIN_EMAIL`
or an invited address. The calendar connection also needs `<APP_URL>/api/google/callback` among the client's redirect URIs.

## Sign-in

Members sign in with Google through Supabase Auth; there is no password or magic-link login.

- In Supabase, enable the Google provider with a Google OAuth web client whose redirect URI is
  `<NEXT_PUBLIC_SUPABASE_URL>/auth/v1/callback`, and add `<APP_URL>/auth/callback` to the Auth redirect allow-list.
  The calendar connection uses its own redirect (`<APP_URL>/api/google/callback`); one Google client can carry both.
- Who gets in: members an admin invited; anyone from a Workspace domain in `ALLOWED_GOOGLE_DOMAINS` (they get a member
  profile on first sign-in); and, on a fresh install, `INITIAL_ADMIN_EMAIL`, which becomes the first admin. With
  `ALLOWED_GOOGLE_DOMAINS` empty, sign-in is invite-only and any Google account (Gmail included) works.
- Deactivated members and everyone else are signed out with a notice.

## Booking pages

- `/` is the general booking page. Settings decide who gets the booking: one member (`website_mode` "person" with
  `website_person_id`) or round robin over all bookable members, where the free member whose last booking from this
  page is oldest wins.
- `/<slug>` is a member's own page. Unknown or not bookable members get the 404 page.
- Both offer the default event type (`settings.default_event_type_id`). Times come from the member's availability
  windows, buffer, minimum notice, daily maximum and the slot horizon, minus Google busy times. Only members with a
  working calendar connection offer times. Slots start every 30 minutes, whatever the duration.
- Booking checks everything again on the server, holds the time, creates the Google event (with Meet when the member
  has it switched on) and saves the booking; if a step fails, nothing stays behind. The invitee lands on
  `/confirmed/<token>`; only the token's hash is stored.
- Brand, privacy and imprint links come from `BRAND_NAME`, `BRAND_LOGO_URL`, `PRIVACY_URL` and `IMPRINT_URL`. With a
  privacy URL set, invitees must confirm they read it.
- Booking attempts are rate limited per client address (`BOOKING_ATTEMPTS_PER_MINUTE`), which is only known behind a
  proxy with `TRUST_PROXY_HEADERS=true`. Without it the limit is per invitee email, plus a global ceiling of 20 times
  that number. A flood of many different emails can still reach the ceiling and pause booking for everyone until it
  stops, so set `TRUST_PROXY_HEADERS=true` in production behind a proxy that appends the client address. Reschedule,
  cancel and "book a new time" are limited per booking instead, so nobody who only knows the invitee's email can lock
  them out of their own booking.
- If the invitee already has an upcoming booking of the event type, the page gives the same answer as for any other
  failure (its text points to the invitation in their email), so nobody can find out from outside whether an email has
  a booking.

## Changes, booking links and the admin

- The confirmation page links to `/reschedule/<token>` and `/cancel/<token>`. Invitees can move a booking to another free
  time of the same host and event type, or cancel it with an optional reason, until it starts. The Google event is
  moved or removed with updates to the guest; a failed move changes nothing. A cancelled booking offers "Book a new
  time" (`/cancel/<token>/new`), a fresh single-use booking link to the same host with the invitee's details filled in.
- Booking links (`/l/<token>`) fix the host and event type and can carry prefill (name, email, company, answers),
  metadata (stored with the booking and sent in the outbox payload), single use and an expiry. Members create and
  revoke their own links under Links in the admin, admins any member's. The link is shown once; only its hash is stored.
  Unknown, used, expired and revoked links all show the same closed page.
- Bookings in the admin lists upcoming bookings (members their own, admins all) with the invitee's answers and the link
  metadata, in the viewer's time zone. Cancelling there removes the Google event with an update to the guest.

## Widgets

- Admins create widgets under Widgets in the admin: name, event type, one person or round robin over chosen members,
  and the sites (origins) allowed to embed it. Each widget shows a window and a section snippet built from `APP_URL`;
  Playground (admins, or any member under `next dev`) tries a widget with a prefill. How to embed: [docs/embedding.md](docs/embedding.md).
- Widget pages (`/widget/<id>`) send `frame-ancestors` with the widget's allowed sites (or `EMBED_ALLOWED_ORIGINS` when it
  has none) plus `APP_URL`, read per request; switched-off and unknown widgets get `'none'`. Every other page keeps
  `frame-ancestors 'none'` and `X-Frame-Options: DENY`. Bookings through a widget are stored with `booked_via` widget,
  the widget and the host page they came from.

## Checks

```bash
npm run lint
npm run typecheck
npm test            # unit tests (Vitest)
npm run test:e2e    # end-to-end tests (Playwright, builds the app first); needs `npm run stack:up`
npm run db:test     # fresh local test database on 127.0.0.1:55432 (Docker), migrations and seed
npm run test:db     # database tests against it
npm run db:lint     # plpgsql_check on the local test database (CI: supabase db lint)
```

The e2e tests start three servers: the production build on `127.0.0.1:3100`, a Google fake on `127.0.0.1:3999`
(`tests/e2e/google-fake.mjs`, test-only; the app uses it only when `GOOGLE_FAKE_URL` points at a loopback host) and a
widget host page (`tests/e2e/embed-site.mjs`, test-only) on `127.0.0.1:3101` as the allowed origin and `127.0.0.1:3102`
as the blocked one; `E2E_EMBED_PORT` and `E2E_EMBED_BLOCKED_PORT` move these two ports. The
fake covers the calendar connection (consent, tokens, calendar list, free/busy) and events (insert with Meet, list,
move, delete); its state is kept per email and calendar, so parallel tests do not share it. It cannot stand in for the Supabase
login: GoTrue's Google provider always calls accounts.google.com. Without `.env.e2e.local` the e2e run fails instead
of skipping logged-in tests. In CI the `e2e` job uses `supabase start` and writes the same file from `supabase status`.

## License

[AGPL-3.0](LICENSE)
