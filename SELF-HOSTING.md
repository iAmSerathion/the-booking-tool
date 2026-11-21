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
   never uses email or password logins. Leave **Allow new users to sign up** on: the first admin and members from
   `ALLOWED_GOOGLE_DOMAINS` get their Supabase Auth user at their first Google sign-in. The app decides who gets in
   (`/auth/callback`) and removes refused accounts that have no profile from Supabase Auth again.
5. **Authentication → URL Configuration**: set the Site URL to `APP_URL` and add `<APP_URL>/auth/callback` to the
   redirect URLs.
6. Copy the project URL (`https://<project ref>.supabase.co`, for `NEXT_PUBLIC_SUPABASE_URL`), the `anon` key
   (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) and the `service_role` key (`SUPABASE_SERVICE_ROLE_KEY`). The app was tested with
   these JWT-based keys; on current projects they are under **Project Settings → API Keys → Legacy API keys**. The
   newer publishable and secret keys are untested. The service role key bypasses row level security; keep it on the
   server only.

Vault (`supabase_vault`) is created by the first migration. pg_cron and pg_net are only needed for the optional
database scheduler (section 6).

### Local or self-hosted Supabase

`npm run stack:up` is for development and tests only: it starts from scratch and deletes all data on every run
(see [CONTRIBUTING.md](CONTRIBUTING.md)). `supabase start` (with `supabase/config.toml`) is the Supabase CLI's
development stack as well: it publishes its ports on all interfaces and its redirect allow-list only names local
development URLs, so do not use it for an instance.

For your own infrastructure, use Supabase's self-hosting Docker setup behind a firewall, or with its ports bound to
127.0.0.1 behind your reverse proxy. It should work the same way as a hosted project (Auth, PostgREST and Vault), but
it is not tested. Configure the Google provider there through GoTrue's `GOTRUE_EXTERNAL_GOOGLE_ENABLED`,
`GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID`, `GOTRUE_EXTERNAL_GOOGLE_SECRET` and `GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI`
(`<SUPABASE_URL>/auth/v1/callback`), and set the site URL and redirect allow-list as in step 5 above.

## 3. Environment variables

Every variable is read by `lib/config.ts`; `.env.example` lists the same set with comments (a unit test keeps the
two in sync). Until every variable is valid, pages and routes fail with an "Invalid configuration" error that lists
every missing or invalid variable.

`next build` prerenders and checks the configuration too, so the build environment needs every required variable,
secrets included; with one missing the build stops with the same list. Set the same values for `next build` and
`next start`.

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
| `SMTP_URL` | `smtp://` or `smtps://` URL with credentials, e.g. `smtps://user:password@smtp.example.com:465` (TLS from the start) or `smtp://user:password@smtp.example.com:587?requireTLS=true` (STARTTLS). Secret. See section 5. |
| `MAIL_FROM` | Sender of all mails, e.g. `Bookings <bookings@example.com>`. |

### Optional

| Variable | Default | What |
|---|---|---|
| `BRAND_NAME` | `the-booking-tool` | Name shown on booking pages and in mails. |
| `BRAND_LOGO_URL` | none | Logo, https URL. |
| `PRIVACY_URL` | none | Your privacy policy, linked on booking pages. When set, invitees must confirm they read it. |
| `IMPRINT_URL` | none | Your imprint (legal notice), linked on booking pages. |
| `DEFAULT_LOCALE` | `de` | `de` or `en`: language of pages and mails. |
| `DEFAULT_TIMEZONE` | `Europe/Berlin` | IANA time zone that booking and reschedule pages show when the invitee's browser zone is unknown, and the fallback for stored invitee time zones. It does not set members' zones: new members start on `Europe/Berlin` and change it under Settings. |
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

Then make your first booking page work. The admin lives at `<APP_URL>/app`:

1. **Settings → Google Calendar:** "Connect Google Calendar" and allow the calendar permission.
2. **Settings → Availability:** check your weekly windows (new members start with Monday to Friday, 09:00-12:00 and
   14:00-17:00) and "Save availability". Without windows a booking page shows no times.
3. **Settings → Booking rules:** check the time zone (new members start on `Europe/Berlin`), buffer, minimum notice and
   the Google Meet option.
4. **Team:** the first admin is not bookable. Click "Make bookable" on your own entry (and "Change link name" for a
   page of your own at `<APP_URL>/<link name>`), or invite the members who take bookings with "Bookable" ticked (no
   mail is sent; tell them to sign in at `<APP_URL>/login`). "Website bookings" chooses who gets bookings from `/`.
5. **Event types:** check the default type the migrations create.
6. Open `<APP_URL>/` (or `<APP_URL>/<link name>`) and book a test time.

Who may sign in is described in [docs/features.md](docs/features.md#sign-in).

## 5. Mail (SMTP)

Any SMTP provider works (a transactional mail service or your own server). Set `SMTP_URL` and `MAIL_FROM`.
`smtps://...:465` uses TLS from the start. `smtp://...:587` upgrades with STARTTLS when the server offers it, but would
otherwise send the credentials in plain text; add `?requireTLS=true` (for example
`smtp://user:password@smtp.example.com:587?requireTLS=true`) so it refuses to send without TLS. Use a
sender address on a domain whose SPF and DKIM records allow that provider. Mails to the invitee reply to the host,
mails to the host reply to the invitee. Google also sends its own calendar invitation and updates to the invitee, so
invitees are told even if a mail fails. Failed sends are retried by the scheduler (1 min, 5 min, 30 min, 2 h, 6 h);
see [docs/features.md](docs/features.md#mail).

## 6. Scheduler

`POST <APP_URL>/api/jobs/scheduler` runs reminders, mail retries, the calendar upkeep (push channel renewal and the
15-minute safety sync) and the webhook outbox. Something has to call it **every minute** with
`Authorization: Bearer <SCHEDULER_SECRET>`. Without it no reminders, retries or webhooks go out, calendar push
channels are not renewed (they expire within a week, and then calendar changes stop reaching bookings) and there is no
15-minute safety sync. A run may take up to 60 seconds.

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
`select cron.unschedule('booking-scheduler');`. `vault.update_secret` takes the secret's id, not its name, and
`create_secret` with an existing name fails. After changing `SCHEDULER_SECRET` (or `APP_URL`), update the secrets:

```sql
select vault.update_secret((select id from vault.secrets where name = 'scheduler_secret'), '<new SCHEDULER_SECRET>');
select vault.update_secret((select id from vault.secrets where name = 'scheduler_url'), '<new APP_URL>/api/jobs/scheduler');
```

To check that it runs, look at the job runs and at the HTTP responses pg_net received (pg_net keeps them for a few
hours):

```sql
select status, return_message, start_time from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'booking-scheduler') order by start_time desc limit 5;

select status_code, error_msg, created from net._http_response order by created desc limit 5;
```

A run marked `succeeded` only means the request was queued. The responses should have `status_code` 200; `401` means
the Vault secret `scheduler_secret` does not match `SCHEDULER_SECRET`, and an empty `status_code` with an `error_msg`
means the app was not reachable at `scheduler_url` (or timed out).

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
  npm run build                                       # next build, with every required variable set (section 3)
  npx next start --hostname 127.0.0.1 --port 3000     # loopback only
  ```

  Expose it only through your HTTPS reverse proxy (section 7), which forwards to `127.0.0.1:3000`. Plain `npm start`
  (`next start`) listens on all interfaces; use it only on platforms that handle the networking for you.
- **Vercel** works as well: import the repository, set the variables, and use an external cron or pg_cron for the
  scheduler. The scheduler route sets `maxDuration = 60`.
- **No Dockerfile** is provided in this release.

## 9. Upgrading

1. Read the changes since your version.
2. Apply new migrations first: `npx supabase db push` (it applies only migrations the database does not have yet).
   Migrations are never edited after release; each change is a new file.
3. Compare your environment with the new `.env.example` and set new required variables **before** you deploy: the
   build checks the configuration and stops if one is missing.
4. Deploy the new code (`npm ci && npm run build`, then restart).

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
  Call it once by hand with the curl command above. With pg_cron, check `net._http_response` and
  `cron.job_run_details` (section 6): `401` there means the Vault secret differs from `SCHEDULER_SECRET`. Failed mails
  keep a short reason in `outbound_mails.last_error`.
- **Calendar changes take up to 15 minutes:** push is not active, because `APP_URL` is not public https or Google
  refused the channel (retried hourly).
- **Webhooks not arriving:** check `booking_outbox.last_error` (`http 500`, `timeout`, `network error`,
  `not configured`, `expired`) and [docs/webhooks.md](docs/webhooks.md).
- **Widget shows a blank frame:** see the troubleshooting in [docs/embedding.md](docs/embedding.md#troubleshooting).
