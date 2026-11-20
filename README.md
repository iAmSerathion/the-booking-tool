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

Seeded members: `admin.demo@example.com` (admin) and `host.demo@example.com` (bookable). Login is Google only, so
locally only the e2e tests sign in, with generated magic-link sessions (`tests/e2e/session.ts`).

## Sign-in

Members sign in with Google through Supabase Auth; there is no password or magic-link login.

- In Supabase, enable the Google provider with a Google OAuth web client whose redirect URI is
  `<NEXT_PUBLIC_SUPABASE_URL>/auth/v1/callback`, and add `<APP_URL>/auth/callback` to the Auth redirect allow-list.
  The calendar connection uses its own redirect (`<APP_URL>/api/google/callback`); one Google client can carry both.
- Who gets in: members an admin invited; anyone from a Workspace domain in `ALLOWED_GOOGLE_DOMAINS` (they get a member
  profile on first sign-in); and, on a fresh install, `INITIAL_ADMIN_EMAIL`, which becomes the first admin. With
  `ALLOWED_GOOGLE_DOMAINS` empty, sign-in is invite-only and any Google account (Gmail included) works.
- Deactivated members and everyone else are signed out with a notice.

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

The e2e tests start two servers: the production build on `127.0.0.1:3100` and a Google fake on `127.0.0.1:3999`
(`tests/e2e/google-fake.mjs`, test-only; the app uses it only when `GOOGLE_FAKE_URL` points at a loopback host). The
fake covers the calendar connection (consent, tokens, calendar list, free/busy). It cannot stand in for the Supabase
login: GoTrue's Google provider always calls accounts.google.com. Without `.env.e2e.local` the e2e run fails instead
of skipping logged-in tests. In CI the `e2e` job uses `supabase start` and writes the same file from `supabase status`.

## License

[AGPL-3.0](LICENSE)
