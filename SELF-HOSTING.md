# Self-hosting

What an instance needs and how to set it up. Below, `APP_URL` is the public origin of your instance (for example
`https://booking.example.com`) and `SUPABASE_URL` the URL of your Supabase project (`NEXT_PUBLIC_SUPABASE_URL`).

You need:

1. A Google Cloud project with the Calendar API and an OAuth web client.
2. A Supabase project (Postgres, Auth, Vault).
3. An SMTP server for mail.
4. A Node 24 runtime for the Next.js app, on a public HTTPS domain.
5. Something that calls the scheduler every minute.

## 1. Google Cloud

1. Create a project in the Google Cloud console and enable the **Google Calendar API**.
2. Set up the **OAuth consent screen** (Google Auth Platform):
   - **Internal**: only accounts of your Google Workspace organisation can sign in. No verification needed. Best for a
     team on one Workspace.
   - **External, publishing status Testing**: any Google account you add as a test user (at most 100). Google expires
     refresh tokens of apps in Testing after 7 days, so members must reconnect their calendar weekly. Fine for trying
     it out.
   - **External, In production**: anyone. The calendar scope is a sensitive scope, so Google requires app verification
     before it shows the consent screen without warnings. It is not a restricted scope (no Gmail scopes), so no
     security assessment (CASA) is needed.
3. Add the scopes `openid`, `email`, `profile` and `https://www.googleapis.com/auth/calendar`. The full calendar scope
   is needed: narrower scopes miss events marked "free", such as holidays.
   Sign-in asks only for `openid email profile`; the calendar scope is asked for separately when a member connects
   their calendar (`/api/google/connect`), with offline access, so Google returns a refresh token.
4. Create an **OAuth client ID** of type **Web application** with both redirect URIs:
   - `<APP_URL>/api/google/callback` (calendar connection)
   - `<SUPABASE_URL>/auth/v1/callback` (sign-in through Supabase Auth)

   One client carries both. Its client ID and secret go into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` and into
   the Supabase Google provider. (Two separate clients also work, as long as the app's variables hold the client with
   the `/api/google/callback` redirect.)

## 2. Supabase

Plain Postgres is not supported: the app needs Supabase Auth, PostgREST and Vault (Google refresh tokens are stored in
Vault).

### Hosted project

1. Create a project at supabase.com.
2. Apply the migrations with the Supabase CLI (a dev dependency of this repo):

   ```bash
   npx supabase login
   npx supabase link --project-ref <project ref>
   npx supabase db push
   ```

   `db push` applies `supabase/migrations` only. **Do not** push `supabase/seed.sql` (`--include-seed`): it is
   example data for development, and its active example admin would stop `INITIAL_ADMIN_EMAIL` from creating your
   first admin.
3. **Authentication → Sign In / Providers → Google**: enable it with the client ID and secret from step 1.
4. **Authentication → Sign In / Providers → Email**: switch the Email provider off. Sign-in is Google only; the app
   never uses email or password logins.
5. **Authentication → URL Configuration**: set the Site URL to `APP_URL` and add `<APP_URL>/auth/callback` to the
   redirect URLs.
6. **Project Settings → API**: copy the project URL (`NEXT_PUBLIC_SUPABASE_URL`), the anon public key
   (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) and the service role key (`SUPABASE_SERVICE_ROLE_KEY`). The service role key
   bypasses row level security; keep it on the server only.

Vault (`supabase_vault`) is created by the first migration. pg_cron and pg_net are only needed for the optional
database scheduler (section 6).

### Local or self-hosted Supabase

`npm run stack:up` is for development and tests only: it starts from scratch and deletes all data on every run
(see [CONTRIBUTING.md](CONTRIBUTING.md)). For your own infrastructure, a self-hosted Supabase (with Auth, PostgREST and
Vault) should work the same way as a hosted project, but it is not tested. `supabase/config.toml` enables the Google
provider with `client_id = "env(GOOGLE_CLIENT_ID)"` and `secret = "env(GOOGLE_CLIENT_SECRET)"`, so export both before
`supabase start`; its redirect allow-list only names local development URLs.

## 3. Environment variables

Every variable is read by `lib/config.ts`; `.env.example` lists the same set with comments (a unit test keeps the
two in sync). Until every variable is valid, pages and routes fail with an "Invalid configuration" error that lists
every missing or invalid variable. Values are read at runtime; set them in the environment of both `next build` and `next start`.

### Required

| Variable | What |
|---|---|
| `APP_URL` | Public origin of the instance, no path (e.g. `https://booking.example.com`). All links in mails, widgets and the Google redirect use it, never request headers. |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon public key. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key. Secret. |
| `GOOGLE_CLIENT_ID` | OAuth web client ID (section 1). |
| `GOOGLE_CLIENT_SECRET` | OAuth web client secret. Secret. |
| `SCHEDULER_SECRET` | Bearer token for `POST <APP_URL>/api/jobs/scheduler`, at least 32 characters (`openssl rand -hex 32`). Secret. |
| `SMTP_URL` | `smtp://` or `smtps://` URL with credentials, e.g. `smtps://user:password@smtp.example.com:465`. Secret. |
| `MAIL_FROM` | Sender of all mails, e.g. `Bookings <bookings@example.com>`. |

### Optional

| Variable | Default | What |
|---|---|---|
| `BRAND_NAME` | `the-booking-tool` | Name shown on booking pages and in mails. |
| `BRAND_LOGO_URL` | none | Logo, https URL. |
| `PRIVACY_URL` | none | Your privacy policy, linked on booking pages. When set, invitees must confirm they read it. |
| `IMPRINT_URL` | none | Your imprint (legal notice), linked on booking pages. |
| `DEFAULT_LOCALE` | `de` | `de` or `en`: language of pages and mails. |
| `DEFAULT_TIMEZONE` | `Europe/Berlin` | IANA time zone for new accounts. |
| `ALLOWED_GOOGLE_DOMAINS` | empty | Comma-separated Google Workspace domains whose accounts get a member profile on first sign-in (checked against Google's `hd` claim, not the email). Empty: invited members only, any Google account works. |
| `GOOGLE_HOSTED_DOMAIN` | none | Workspace domain sent to Google as the `hd` hint, so the account chooser shows only that domain. Then only emails of that domain can be invited. |
| `INITIAL_ADMIN_EMAIL` | none | On a fresh install the first Google sign-in with this address creates the admin profile. Once an active admin exists it has no effect. |
| `REQUIRE_SAME_GOOGLE_EMAIL` | `false` | `true`: the calendar a member connects must use the same Google account email as their sign-in. |
| `TRUST_PROXY_HEADERS` | `false` | `true` only behind a proxy that appends the client address to `X-Forwarded-For` (see section 7). |
| `BOOKING_ATTEMPTS_PER_MINUTE` | `10` | Booking attempts per minute and client address, or per invitee email without `TRUST_PROXY_HEADERS`. |
| `WEBHOOK_URL` | none | Receiver of signed booking events ([docs/webhooks.md](docs/webhooks.md)). https only (plain http only for localhost, 127.0.0.1 or [::1]); no username or password in the URL. Without it, events are given up instead of kept. |
| `WEBHOOK_SECRET` | none | HMAC secret, at least 32 characters. Required when `WEBHOOK_URL` is set. |
| `EMBED_ALLOWED_ORIGINS` | empty | Comma-separated origins (e.g. `https://www.example.com`, at most 20) that may embed widgets which list no allowed origins of their own. Plain http only for localhost or 127.0.0.1. Empty: such widgets can only be tried in the admin playground. |

### Test only

Never set these in production. Config refuses both off loopback.

| Variable | What |
|---|---|
| `GOOGLE_FAKE_URL` | Base URL of the Google fake used by the e2e tests (`tests/e2e/google-fake.mjs`). Only localhost or 127.0.0.1. |
| `SCHEDULER_TEST_CLOCK` | `true` lets the scheduler run on a simulated clock (`x-test-now`, scoped to one booking or member). Refused unless `APP_URL` is localhost, 127.0.0.1 or [::1]. |

## 4. First admin

Set `INITIAL_ADMIN_EMAIL` to your Google account's email before the first sign-in, then open `<APP_URL>/login` and
sign in with Google. With no active admin in the database, that sign-in creates your profile as admin (the database
re-checks this under a lock, so two simultaneous first sign-ins cannot both become admin). Google must report the
email as verified. After that the variable has no effect; you can leave it or remove it.

Then, in the admin: connect your calendar under Settings, adjust the event types (the migrations create a default one), and invite members under Team (no mail
is sent; tell them to sign in at `<APP_URL>/login`). Who may sign in is described in
[docs/features.md](docs/features.md#sign-in).

## 5. Mail (SMTP)

Any SMTP provider works (a transactional mail service or your own server). Set `SMTP_URL` and `MAIL_FROM`; use a
sender address on a domain whose SPF and DKIM records allow that provider. Mails to the invitee reply to the host,
mails to the host reply to the invitee. Google also sends its own calendar invitation and updates to the invitee, so
invitees are told even if a mail fails. Failed sends are retried by the scheduler (1 min, 5 min, 30 min, 2 h, 6 h);
see [docs/features.md](docs/features.md#mail).

## 6. Scheduler

`POST <APP_URL>/api/jobs/scheduler` runs reminders, mail retries, the calendar upkeep (push channel renewal and the
15-minute safety sync) and the webhook outbox. Something has to call it **every minute** with
`Authorization: Bearer <SCHEDULER_SECRET>`. Without it no reminders, retries or webhooks go out and calendar changes
stop reaching bookings. A run may take up to 60 seconds.

### Option A: any external cron

```bash
curl -fsS -X POST -H "Authorization: Bearer $SCHEDULER_SECRET" "$APP_URL/api/jobs/scheduler"
```

System cron (`* * * * *`), a container, or your host's scheduled jobs all work. Keep the secret out of logs and
process lists where you can (for example read it from a file in the cron script).

### Option B: pg_cron in Supabase

Run `supabase/optional/scheduler_cron.sql` once in the SQL editor of your project. It is not part of the migrations
and is never applied by default. First store the two Vault secrets it reads:

```sql
select vault.create_secret('<APP_URL>/api/jobs/scheduler', 'scheduler_url');
select vault.create_secret('<SCHEDULER_SECRET>', 'scheduler_secret');
```

The file enables pg_cron and pg_net and schedules the job `booking-scheduler` every minute. To stop it:
`select cron.unschedule('booking-scheduler');`. After changing `SCHEDULER_SECRET`, update the Vault secret with
`vault.update_secret`.

## 7. Domain, HTTPS and proxies

The instance needs a public HTTPS origin:

- **Calendar push:** Google only notifies https addresses with a valid certificate
  (`<APP_URL>/api/google/calendar-webhook`). Without push, calendar changes reach bookings within 15 minutes through
  the scheduler's sync instead of within seconds.
- **Embedding:** widgets on other sites load `<APP_URL>/widget.js` and frame `<APP_URL>/widget/<id>`; https sites
  cannot embed plain http content.
- **Google sign-in** and the calendar connection redirect to `APP_URL`, which must match the redirect URIs exactly.

**`TRUST_PROXY_HEADERS`.** The app sees no socket address, so it can only rate limit booking attempts per client
address when a proxy tells it the address. With `TRUST_PROXY_HEADERS=true` it takes the **rightmost**
`X-Forwarded-For` entry, which must be the one your proxy appended; entries further left are whatever the client sent.

- Set it to `true` when exactly one proxy in front of the app appends the client address (nginx with
  `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, Caddy, Traefik, or a platform such as Vercel that
  sets the header itself; check your platform's documentation).
- With several proxies in a chain, make the last one set the header to the real client address, or all clients share
  one bucket.
- Leave it `false` when the app is reachable without the proxy: anyone could then send a fake header. Without it the
  limit is per invitee email, plus a global ceiling of 20 times the limit; a flood of many different emails can reach
  that ceiling and pause booking for everyone until it stops.

## 8. Runtime and deployment

- **Node.js 24 or newer** (`engines` in `package.json`).
- Build and start:

  ```bash
  npm ci
  npm run build      # next build
  npm start          # next start, port 3000 by default
  ```

  Behind a reverse proxy, bind the app to loopback only: `npx next start --hostname 127.0.0.1 --port 3000`.
- **Vercel** works as well: import the repository, set the variables, and use an external cron or pg_cron for the
  scheduler. The scheduler route sets `maxDuration = 60`.
- **No Dockerfile** is provided in this release.

## 9. Upgrading

1. Read the changes since your version.
2. Apply new migrations first: `npx supabase db push` (it applies only migrations the database does not have yet).
   Migrations are never edited after release; each change is a new file.
3. Deploy the new code (`npm ci && npm run build`, then restart).
4. Compare your environment with `.env.example` for new variables.

## 10. Backups and data retention

- Back up the Supabase database (hosted projects have daily backups depending on the plan; otherwise use `pg_dump`).
  Everything lives there: profiles, settings, event types, bookings, links, widgets, mails, jobs and the webhook
  outbox. Google refresh tokens are in Vault, encrypted with a key of the Supabase project; a restore into another
  project may not be able to decrypt them, and then members reconnect their calendars.
- Automatic deletion:
  - Webhook events (`booking_outbox`): delivered and given-up events are deleted after **30 days**, since they hold
    the invitee's personal data. Events still pending after 72 hours are given up.
  - Booking attempts for the rate limit: older than one hour. Expired slot holds: on the next booking attempt.
- Kept until you delete them: bookings (with invitee name, email, company, answers and link metadata) and the
  composed mails in `outbound_mails`. Deleting a booking also deletes its mails. Set your own retention to match your
  privacy policy.

## 11. Troubleshooting

- **"Invalid configuration" with a list of variables:** fix every listed variable; the message says what is wrong
  (missing, not a URL, secret shorter than 32 characters, test-only switch off loopback).
- **Google says `redirect_uri_mismatch`:** the OAuth client lacks `<SUPABASE_URL>/auth/v1/callback` (sign-in) or
  `<APP_URL>/api/google/callback` (calendar). Scheme, host, port and path must match exactly.
- **After sign-in you land on Supabase's Site URL or a wrong host:** add `<APP_URL>/auth/callback` to the Supabase
  redirect URLs.
- **"No access" after sign-in:** the account is not invited, its Workspace domain is not in `ALLOWED_GOOGLE_DOMAINS`,
  the member is deactivated, or `INITIAL_ADMIN_EMAIL` was used after an admin already existed (for example because the
  seed was applied). Refused accounts without a profile are removed from Supabase Auth again, so an admin can still
  invite them.
- **The calendar connection fails or is refused:** the member unticked the calendar permission on Google's consent
  screen, the Calendar API is not enabled, or `REQUIRE_SAME_GOOGLE_EMAIL=true` and they picked another account.
- **Calendars disconnect after a week:** the consent screen is External in Testing; use Internal or publish the app.
- **No times on a booking page:** the member is not bookable, has no working calendar connection, or has no
  availability windows within the slot horizon.
- **No reminders, mails stuck in `pending`, no webhooks:** the scheduler is not called or gets `401` (wrong secret).
  Call it once by hand with the curl command above. Failed mails keep a short reason in `outbound_mails.last_error`.
- **Calendar changes take up to 15 minutes:** push is not active, because `APP_URL` is not public https or Google
  refused the channel (retried hourly).
- **Webhooks not arriving:** check `booking_outbox.last_error` (`http 500`, `timeout`, `network error`,
  `not configured`, `expired`) and [docs/webhooks.md](docs/webhooks.md).
- **Widget shows a blank frame:** see the troubleshooting in [docs/embedding.md](docs/embedding.md#troubleshooting).
