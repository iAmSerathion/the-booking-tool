# How it works

What each part of the tool does, as the code does it. Setup is in [SELF-HOSTING.md](../SELF-HOSTING.md), webhooks in
[webhooks.md](webhooks.md), embedding in [embedding.md](embedding.md).

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
- Both offer the default event type (`settings.default_event_type_id`). With more than one active event type, a row of
  links above the form switches to another one (`?type=<event type link name>`, e.g. `/?type=discovery-call`); unknown
  or switched-off types get the 404 page. Booking links and widgets keep their fixed event type. Times come from the member's availability
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
  Playground (admins, or any member under `next dev`) tries a widget with a prefill. How to embed: [embedding.md](embedding.md).
- Widget pages (`/widget/<id>`) send `frame-ancestors` with the widget's allowed sites (or `EMBED_ALLOWED_ORIGINS` when it
  has none) plus `APP_URL`, read per request; switched-off and unknown widgets get `'none'`. Every other page keeps
  `frame-ancestors 'none'` and `X-Frame-Options: DENY`. Bookings through a widget are stored with `booked_via` widget,
  the widget and the host page they came from.

## Event types

- Admins manage event types under Event types in the admin: title, link name, description, duration (5 to 480 minutes,
  steps of 5) and up to 20 booking questions (one choice, several choices or text, each optional or required). The
  answers are stored with the booking, sent in the outbox payload and shown under Bookings. Questions keep their id
  when edited, so prefills and stored answers still match; removing one drops its prefill.
- One active type is the default (what `/` and `/<slug>` book without `?type=`); it cannot be switched off until
  another type is the default. Event types are never deleted. Switching one off closes its widgets and booking links.

## Team

- Team in the admin lists every member with their booking page. Admins make members admin or bookable, change link
  names (the old `/<slug>` stops working; reserved words are the app's routes), invite members by their Google account
  email, reactivate deactivated members and choose who gets bookings from `/` (one person or round robin). At least
  one active member always stays an admin.
- An invite creates the account and profile; no mail is sent, so the admin tells the person to sign in at
  `<APP_URL>/login`. Invited members get in whatever `ALLOWED_GOOGLE_DOMAINS` says; with `GOOGLE_HOSTED_DOMAIN` set,
  only emails of that domain can be invited. New members start not bookable until they connect a calendar.
- Deactivating a member hands everything to a successor: their upcoming bookings get new events in the successor's
  calendar (invitees get a new invitation with a new confirmation link, and the old event is cancelled), their widgets
  and website bookings move, and their Google connection is revoked and removed. The successor must be bookable with
  a connected calendar when there is anything to take over. If Google or the database refuses, the new events are
  deleted again and nothing changes. Deactivated members cannot sign in and their booking page is gone; reactivating
  them gives nothing back.

## Mail

- Mail goes out over SMTP (`SMTP_URL`, `smtp://` or `smtps://` with credentials in the URL) from `MAIL_FROM`. Mails to
  the invitee reply to the host; mails to the host reply to the invitee.
- After a booking: a confirmation to the invitee (when, what, with whom, the Meet link, and links to reschedule or
  cancel, all from `APP_URL`) and a notice to the host with the invitee's details and answers. Google sends the
  calendar invitation itself, so the mail carries no `.ics`. A new time and a cancellation each send one mail to both
  sides, with "book a new time" for the invitee; a host who cancels their own booking gets no notice, an admin's cancel
  is told to the host. The copy is in `messages/` (`mail.*`, German and English, `DEFAULT_LOCALE`).
- Each occasion is one `outbound_mails` row with a unique `send_key`, written before the first attempt, so it goes out
  once (at least once if SMTP accepts a mail and the "sent" update is lost). The row keeps the composed mail. A failed
  attempt is retried with backoff (1 min, 5 min, 30 min, 2 h, 6 h) by the scheduler (`retryDueMails`), never at or after
  the row's `send_until` (the booking's start for most mails); then it is marked failed. A retry is also dropped once
  the booking is cancelled (except the cancel notices) or, for reminders and calendar move notices, moved.

## Reminders and the scheduler

- Every booking gets reminder mails to the invitee, by default 24 hours and 1 hour before the start. Set the settings
  row `reminder_offsets_minutes` to a JSON array of minutes (e.g. `[2880, 120]`, at most 5, up to 30 days; `[]` turns
  reminders off). A reminder carries fresh reschedule and cancel links. A late reminder still goes out until the next
  smaller one is due (the smallest until the start); a booking that was moved or cancelled gets none for the old time.
- Reminders are `booking_jobs`, planned after a booking and re-planned after a reschedule; a cancel or a move cancels
  the open ones in the database.
- `POST /api/jobs/scheduler` runs due jobs, mail retries, the calendar upkeep and the webhooks ([webhooks.md](webhooks.md)). Something has to call it
  every minute with `Authorization: Bearer <SCHEDULER_SECRET>` (at least 32 characters, compared in constant time):

  ```bash
  curl -fsS -X POST -H "Authorization: Bearer $SCHEDULER_SECRET" "$APP_URL/api/jobs/scheduler"
  ```

  Any cron works (system cron, a container, your host's scheduled jobs). On Supabase you can instead run
  `supabase/optional/scheduler_cron.sql` once (pg_cron and pg_net, secrets in Vault); it is not part of the migrations
  and is never applied by default.
- `SCHEDULER_TEST_CLOCK=true` is for the e2e tests only: the scheduler then honours `x-test-now`, scoped to one booking
  (`x-test-booking`: its jobs, mail retries and webhooks) or member (`x-test-user`: calendar upkeep). Config refuses it unless `APP_URL` is localhost, 127.0.0.1 or [::1].

## Calendar sync

- Changes made in a host's Google calendar reach the booking: the host moving the event moves the booking (the
  reminders are planned anew, and the invitee gets a mail with the new time and fresh links); the host deleting the
  event cancels the booking as the host (the invitee is told); the invitee declining the invitation cancels it like the
  cancel link (the event is removed, both sides are told, with the same mails, so never twice). Other guests' answers
  and the host's own decline are only stored. Past bookings are not cancelled from the calendar.
- Events the database does not know are skipped, including events with this tool's `booking_id` property from another
  install sharing the calendar. While an invitee's reschedule is moving the event, changes to that booking wait for the
  next sync. Each event is applied on its own; one that fails is logged and skipped.
- Google pushes changes to `$APP_URL/api/google/calendar-webhook` through a channel per member, created right after
  connecting and renewed daily by the scheduler; disconnecting or deactivating a member stops it. Google only notifies
  **https** addresses with a valid certificate, so `APP_URL` must be public https for push. The route answers at once
  and checks the channel id and secret (stored as a hash). Without push (plain http, or Google refused the channel,
  retried hourly) the scheduler still syncs every connected calendar every 15 minutes.

