# the-booking-tool

A self-hostable booking tool: connect your Google Calendar, share booking pages and personal links, and embed booking widgets on your website.

Work in progress. Not ready for use yet.

## Stack

Next.js (App Router), Supabase (Postgres, Auth, Vault), Google Calendar and Meet, SMTP for mail.

## Local development

Requirements: Node 24+ and Docker. The Supabase CLI comes pinned as a dev dependency (`npx supabase`).

```bash
npm install
cp .env.example .env.local   # fill in the values, see comments in the file
```

The local Supabase needs the Google OAuth client too. Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` into `supabase/.env` (ignored by git) or export them, then:

```bash
npx supabase start           # prints the local Supabase URL and keys for .env.local
npm run dev
```

## Checks

```bash
npm run lint
npm run typecheck
npm test            # unit tests (Vitest)
npm run test:e2e    # end-to-end tests (Playwright, builds the app first)
npm run db:test     # fresh local test database on 127.0.0.1:55432 (Docker), migrations and seed
npm run test:db     # database tests against it
npm run db:lint     # plpgsql_check on the local test database (CI: supabase db lint)
```

## License

[AGPL-3.0](LICENSE)
