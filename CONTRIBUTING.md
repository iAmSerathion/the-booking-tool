# Contributing

Thanks for helping. Bug reports and pull requests are welcome; for larger changes, open an issue first so we can agree
on the approach. Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Local development

Requirements: Node 24+ (`engines` in `package.json`) and Docker.

```bash
npm ci
npm run stack:up             # local Supabase on 127.0.0.1, writes .env.e2e.local
# create .env.local from the minimal block below (copying all of .env.example also works,
# but leaves you to fill every key); the Supabase URL and keys are in .env.e2e.local
npm run dev                  # http://127.0.0.1:3000, bound to 127.0.0.1 only
npm run stack:down           # stop it and delete its data
```

`npm run stack:up` starts Postgres, GoTrue (auth), PostgREST and a Kong gateway with docker compose
(`scripts/stack/`), always from scratch: it applies `supabase/migrations` and `supabase/seed.sql` and generates new
keys each time. The API listens on `127.0.0.1:54421`, Postgres on `127.0.0.1:54422`. Every port is bound to
127.0.0.1 only; `supabase start` would publish on all interfaces. `supabase/config.toml` uses the same ports for CI.
GoTrue accepts redirects to `http://localhost:3000/auth/callback`, `http://127.0.0.1:3000/auth/callback` and
`http://127.0.0.1:3100/auth/callback`, so run the dev server on port 3000 (`npm run dev` does).

Every `stack:up` generates new keys, so copy the keys from `.env.e2e.local` into `.env.local` again after each run.
`.env.e2e.local` also holds `DATABASE_URL`, the stack's Postgres on `127.0.0.1:54422`, for psql and your own scripts.
The app does not read it, and `npm run test:db` uses its own database on port 55432 unless `DATABASE_URL` is set in the
environment.
There is one stack per machine (compose project `tbt-stack`), shared by all checkouts: `stack:up` in a second clone
wipes the first clone's data and keys.

For a working `.env.local` you also need:

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: any placeholder (for example `fake-client` and `fake-secret`) unless
  you sign in by hand with a real Google client ([Signing in locally](#signing-in-locally)).
- `SCHEDULER_SECRET`: any 32+ characters.
- `SMTP_URL` and `MAIL_FROM`. Any SMTP server works; locally you can run the test sink,
  `node tests/e2e/smtp-sink.mjs` (SMTP on `127.0.0.1:2525`, so `SMTP_URL=smtp://127.0.0.1:2525`; it serves the mails
  it caught to one address as JSON at `http://127.0.0.1:2526/messages?to=<address>`).
- For the calendar without Google: `GOOGLE_FAKE_URL=http://127.0.0.1:3999` ([Try it without Google](#try-it-without-google)).

A minimal `.env.local` for trying it without Google (replace the two keys with the values from `.env.e2e.local`):

```bash
APP_URL=http://127.0.0.1:3000
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54421
NEXT_PUBLIC_SUPABASE_ANON_KEY=<NEXT_PUBLIC_SUPABASE_ANON_KEY from .env.e2e.local>
SUPABASE_SERVICE_ROLE_KEY=<SUPABASE_SERVICE_ROLE_KEY from .env.e2e.local>
GOOGLE_CLIENT_ID=fake-client
GOOGLE_CLIENT_SECRET=fake-secret
GOOGLE_FAKE_URL=http://127.0.0.1:3999
SCHEDULER_SECRET=local-scheduler-secret-0123456789abcdef
SMTP_URL=smtp://127.0.0.1:2525
MAIL_FROM="Bookings <bookings@example.com>"
DEFAULT_LOCALE=en
```

### Seed data

`supabase/seed.sql` adds example data only (example.com): `admin.demo@example.com` (admin, not bookable),
`host.demo@example.com` (bookable, page `/demo-host`), the event type `discovery-call` with one question, and a widget
"Example site" for the host, embeddable on `https://example.com`. The migrations add the default event type `meeting`
("Meeting", 30 minutes), so the booking pages (`/demo-host` and `/`) list both; "Meeting" is preselected and the list
above the times switches to the other (`?type=discovery-call`). These users have no password and nobody can receive
mail or own a Google account at example.com, so they cannot be signed in to by Google; use `npm run dev:login`
([Try it without Google](#try-it-without-google)).

### Signing in locally

Login is Google only. The e2e tests sign in with generated magic-link sessions (`tests/e2e/session.ts`), and
`npm run dev:login` does the same for the dev server ([Try it without Google](#try-it-without-google)). By default
the stack carries a fake Google client, so "Sign in with Google" in `npm run dev` fails at Google. To sign in by hand,
create a Google OAuth web client with the redirect URI `http://127.0.0.1:54421/auth/v1/callback`, then start the stack
with it:

```bash
GOOGLE_CLIENT_ID=<client id> GOOGLE_CLIENT_SECRET=<client secret> npm run stack:up
```

Put the same two values and the Supabase keys from `.env.e2e.local` into `.env.local`. The calendar connection also
needs `<APP_URL>/api/google/callback` among the client's redirect URIs.

Who gets in follows the same rules as on a real install (see [docs/features.md](docs/features.md#sign-in)). The
seeded admin is an active admin, so `INITIAL_ADMIN_EMAIL` has no effect on the local stack until you switch it off:

```bash
docker compose -f scripts/stack/compose.yml exec db psql -U postgres -h 127.0.0.1 \
  -c "update public.profiles set active = false where email = 'admin.demo@example.com'"
```

Then the first Google sign-in with `INITIAL_ADMIN_EMAIL` becomes the admin. Alternatively, put your Google Workspace
domain into `ALLOWED_GOOGLE_DOMAINS` to get in as a member.

### Try it without Google

`tests/e2e/google-fake.mjs` stands in for Google's OAuth, Calendar and push endpoints. It listens on `127.0.0.1:3999`
(`GOOGLE_FAKE_PORT` moves it) and hands out tokens to anyone, so it is for local trials and tests only. The app uses it
only when `GOOGLE_FAKE_URL` points at localhost or 127.0.0.1; config refuses anything else. It cannot stand in for the
Supabase login: GoTrue's Google provider always calls accounts.google.com, so you cannot sign in to the admin this way.
Use `npm run dev:login` for that (below).

To book a time by hand on the public pages, with the minimal `.env.local` above:

```bash
npm run stack:up
node tests/e2e/google-fake.mjs     # terminal 1
node tests/e2e/smtp-sink.mjs       # terminal 2
npm run dev                        # terminal 3
npm run dev:calendar               # connects host.demo@example.com to the fake
```

Then open `http://127.0.0.1:3000/demo-host` (or `/`) and book a time. The booking appears as an event in the fake
(`http://127.0.0.1:3999/control/events?calendar=host.demo@example.com`) and the mails in the sink
(`http://127.0.0.1:2526/messages?to=<invitee email>`). `npm run dev:calendar` refuses a Supabase or fake that is not on
localhost or 127.0.0.1. The e2e tests expect the seeded host without a calendar, so run `npm run stack:up` again
before `npm run test:e2e`.

To open the admin (`/app`) without Google, with the stack and the dev server running:

```bash
npm run dev:login                          # the seeded admin, admin.demo@example.com
npm run dev:login -- host.demo@example.com # or any member of the local stack
```

It prints a one-time URL on its own random `127.0.0.1` port and keeps running until you open it (or 10 minutes pass),
then exits; run it in its own terminal and do not pipe it through `tail`. Opening the URL sets the session cookies and redirects to
`<APP_URL>/app`. Like the e2e tests it creates a magic-link session with the service role key; the app itself has no
magic-link login (`/auth/callback` admits Google identities only). It reads the keys from `.env.e2e.local` and
`APP_URL` from `.env.local` (default `http://127.0.0.1:3000`), and refuses a Supabase URL or `APP_URL` that is not
localhost, 127.0.0.1 or [::1].

Nothing calls the scheduler locally, so reminders, mail retries, calendar upkeep and webhooks only run when you call it
once by hand (with `SCHEDULER_SECRET` from `.env.local`):

```bash
SCHEDULER_SECRET=$(grep '^SCHEDULER_SECRET=' .env.local | cut -d= -f2-)
curl -fsS -X POST -H "Authorization: Bearer $SCHEDULER_SECRET" http://127.0.0.1:3000/api/jobs/scheduler
```

To watch full bookings without any manual setup, run the booking tests:
`npx playwright test tests/e2e/booking.spec.ts --project=chromium`.

## Checks

Run these before you open a pull request; CI (`.github/workflows/ci.yml`) runs the same plus a gitleaks secret scan.

```bash
npm run lint
npm run typecheck
npm test            # unit tests (Vitest)
npx playwright install chromium   # once per machine, before the first e2e run
npm run test:e2e    # end-to-end tests (Playwright, builds the app first); needs `npm run stack:up`
npm run db:test     # fresh local test database on 127.0.0.1:55432 (Docker), migrations and seed
npm run test:db     # database tests against it
npm run db:lint     # plpgsql_check on the local test database (CI: supabase db lint)
```

`npm run db:test` takes its port from `TEST_DB_PORT` (default 55432).

The e2e tests start five servers: the production build on `127.0.0.1:3100` (`E2E_PORT`), an SMTP sink
(`tests/e2e/smtp-sink.mjs`, test-only) that takes the app's mail on `127.0.0.1:2525` and hands it to tests on
`127.0.0.1:2526` (`E2E_SMTP_PORT`, `E2E_SMTP_HTTP_PORT`), a Google fake on `127.0.0.1:3999` (`tests/e2e/google-fake.mjs`,
test-only; the app uses it only when `GOOGLE_FAKE_URL` points at a loopback host), a webhook receiver
(`tests/e2e/webhook-receiver.mjs`, test-only) on `127.0.0.1:2527` (`E2E_WEBHOOK_PORT`) and a widget host page
(`tests/e2e/embed-site.mjs`, test-only) on `127.0.0.1:3101` as the allowed origin and `127.0.0.1:3102` as the blocked
one; `E2E_EMBED_PORT` and `E2E_EMBED_BLOCKED_PORT` move these two ports. Outside CI, servers that already run are
reused.

The fake covers the calendar connection (consent, tokens, calendar list, free/busy), events (insert with Meet, list,
move, delete), incremental sync (sync tokens, a 410 on request) and push channels, which notify the app (loopback
addresses only) on every change; its state is kept per email and calendar, so parallel tests do not share it.

The e2e run refuses any Supabase that is not on localhost or 127.0.0.1, since tests create and delete users and rows.
Without `.env.e2e.local` it fails instead of skipping logged-in tests. Specs that change the seeded admin or the website
default run in their own Playwright projects (`team-admins`, then `bootstrap`) after all others. In CI the `e2e` job
uses `supabase start` and writes the same file from `supabase status`.

## Database migrations

- Never edit a migration that is already on `main`: installs have applied it. Every schema change is a **new** file in
  `supabase/migrations/`, named `<YYYYMMDDHHMMSS>_<what>.sql` with a timestamp after the last one.
- Replace functions with `create or replace` in the new file, and keep their grants.
- Functions are `security definer` only where they must be, always with `set search_path = ''` and fully qualified
  names. Revoke execute from `public` and grant it only to the roles that need it.
- Every table has row level security; add policies in the same migration as the table.
- `supabase/optional/` holds SQL that installs apply by hand; it is never part of the migrations.
- Add a database test in `tests/db/` for new functions and run `npm run db:lint`.

## Code style

- TypeScript, strict. Lint with the Next.js ESLint config (`npm run lint`).
- Pure logic lives in `lib/core/` with unit tests next to it (`*.test.ts`); data access and server actions live in the
  feature folders under `lib/`. Pages and routes in `app/` stay thin.
- Configuration comes only from `getConfig()` in `lib/config.ts`. A new variable goes into `requiredEnvKeys` or
  `optionalEnvKeys`, into `.env.example` with a comment (`tests/unit/env-example.test.ts` checks both lists), and into
  [SELF-HOSTING.md](SELF-HOSTING.md).
- Links in mails and pages are built from `APP_URL`, never from request headers.
- User-facing text goes into `messages/de.json` and `messages/en.json`; both must have the same keys.
- `public/widget.js` is plain JavaScript without a build step and without dependencies; it runs on other people's
  sites.
- Comments explain why, not what. Code, comments, commit messages and docs are in English.
- Test-only switches must be refused outside loopback (see `GOOGLE_FAKE_URL` and `SCHEDULER_TEST_CLOCK` in
  `lib/config.ts`). Never gate them on a hosting provider's environment variables.
- Use `example.com` addresses and neutral names in tests, seeds and docs.

## License of contributions

This project is licensed under [AGPL-3.0-only](LICENSE). By submitting a contribution you agree that it is licensed
under AGPL-3.0-only as well. There is no CLA and no copyright assignment; dual licensing is not planned.
