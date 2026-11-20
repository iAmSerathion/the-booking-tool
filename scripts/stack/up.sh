#!/usr/bin/env bash
# Fresh local Supabase (scripts/stack/compose.yml) on 127.0.0.1:54421 (API) and 127.0.0.1:54422 (Postgres):
# starts it, applies supabase/migrations and supabase/seed.sql, and writes .env.e2e.local for the app and Playwright.
set -euo pipefail
cd "$(dirname "$0")/../.."

compose=(docker compose -f scripts/stack/compose.yml)
env_file=.env.e2e.local
api=http://127.0.0.1:54421

eval "$(node scripts/stack/keys.mjs)"
export JWT_SECRET
"${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
"${compose[@]}" up -d --wait --wait-timeout 180

# GoTrue is healthy only after its auth migrations, so the app schema can now go on top (auth.users must be complete).
for file in supabase/migrations/*.sql supabase/seed.sql; do
  echo "applying $file"
  "${compose[@]}" exec -T db psql -U postgres -h 127.0.0.1 -q -v ON_ERROR_STOP=1 -f - <"$file"
done
"${compose[@]}" exec -T db psql -U postgres -h 127.0.0.1 -q -c "notify pgrst, 'reload schema'"

cat >"$env_file" <<ENV
# Written by scripts/stack/up.sh for the local stack. Regenerated (new keys) on every run.
NEXT_PUBLIC_SUPABASE_URL=$api
NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54422/postgres
ENV

# PostgREST reloads its schema cache asynchronously; wait until the seeded profiles are visible through the gateway.
for _ in $(seq 1 30); do
  if curl -sf "$api/rest/v1/profiles?select=id&limit=1" -H "apikey: $SERVICE_ROLE_KEY" | grep -q '"id"'; then
    echo "ready: $api (env in $env_file)"
    exit 0
  fi
  sleep 1
done
echo "stack started, but PostgREST does not serve the schema" >&2
exit 1
