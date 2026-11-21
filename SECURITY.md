# Security policy

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability** (private vulnerability reporting / security advisories). Include what you found, how
to reproduce it, and the impact you expect.

You will get an answer as soon as the maintainers can look at it. Please give us reasonable time to fix the problem
before you disclose it.

## Supported versions

Only the latest `main` gets security fixes. There are no release branches yet.

## Security model in short

- **Secrets stay on the server.** All configuration is read by `lib/config.ts` in server code. Only the Supabase URL
  and anon key are public by design; the service role key, Google client secret, SMTP credentials, scheduler secret
  and webhook secret never reach the browser.
- **Service role and row level security.** Every table has row level security. Members use their own Supabase
  session; public booking flows, the scheduler and admin hand-overs use the service role on the server, mostly
  through database functions that check their inputs and take locks (for example against double bookings).
  Execute rights on those functions are revoked from `public` and granted only to the roles that need them.
- **Sign-in.** Google only, through Supabase Auth. A profile is created only for an invited account, a verified email
  from an allowed Workspace domain (Google's `hd` claim), or `INITIAL_ADMIN_EMAIL` while no active admin exists.
  Deactivated members are signed out. Google refresh tokens are stored in Supabase Vault.
- **Tokens are hashed.** Confirmation, reschedule and cancel tokens, booking link tokens and calendar push channel
  secrets are stored only as hashes; the plain token exists only in the link.
- **Rate limits.** Booking attempts are limited per client address behind a trusted proxy (`TRUST_PROXY_HEADERS`),
  otherwise per invitee email with a global ceiling; reschedule, cancel and "book a new time" per booking. The limit
  fails closed. Answers do not reveal whether an email already has a booking.
- **Scheduler secret.** `POST /api/jobs/scheduler` needs `Authorization: Bearer <SCHEDULER_SECRET>` (at least 32
  characters), compared in constant time.
- **Signed webhooks.** Every webhook carries `X-Signature`, an HMAC-SHA256 of the raw body with `WEBHOOK_SECRET`
  (at least 32 characters). The URL must be https (plain http only for loopback) and may not carry credentials.
  Receivers should check the signature and reject replays ([docs/webhooks.md](docs/webhooks.md)).
- **Embedding.** Widget pages send `Content-Security-Policy: frame-ancestors` with the widget's allowed sites (or `EMBED_ALLOWED_ORIGINS` when it has none) plus `APP_URL`;
  every other page sends `frame-ancestors 'none'` and `X-Frame-Options: DENY`. `widget.js` pins messages to the
  instance's origin, accepts messages only from its own frames, and sends prefill data only by `postMessage` to that
  origin, never in a URL. Host pages receive events without invitee data.
- **Links from `APP_URL` only.** Links in mails and pages are built from `APP_URL`, never from request headers, so a
  forged `Host` header cannot redirect reschedule or cancel links.
- **Test-only switches are refused outside loopback.** `GOOGLE_FAKE_URL` must point at localhost or 127.0.0.1, and
  `SCHEDULER_TEST_CLOCK=true` needs a loopback `APP_URL`; config refuses anything else. No behaviour depends on a
  hosting provider's environment variables.
- **Headers.** `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`
  on every response, so tokens in URLs are not sent to other sites.

## Operator responsibilities

Keep the service role key and the other secrets out of version control and logs, run the app behind HTTPS, set
`TRUST_PROXY_HEADERS` only behind a proxy you control, never apply `supabase/seed.sql` to a real install, and apply new
migrations when you upgrade. See [SELF-HOSTING.md](SELF-HOSTING.md).
