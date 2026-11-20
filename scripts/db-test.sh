#!/usr/bin/env bash
# Fresh local test database: Supabase Postgres on 127.0.0.1 only, all migrations plus seed.
# CI uses `supabase db reset` instead; this script exists because `supabase start` binds 0.0.0.0.
set -euo pipefail
cd "$(dirname "$0")/.."

name=tbt-testdb
port=${TEST_DB_PORT:-55432}
image=public.ecr.aws/supabase/postgres:17.11.0.006

docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" -e POSTGRES_PASSWORD=postgres -p "127.0.0.1:$port:5432" "$image" >/dev/null
# The image restarts Postgres once after init; wait until it answers twice in a row.
ok=0
for _ in $(seq 1 60); do
  if docker exec "$name" psql -U postgres -h 127.0.0.1 -Atc "select 1" >/dev/null 2>&1; then ok=$((ok + 1)); else ok=0; fi
  [ "$ok" -ge 2 ] && break
  sleep 1
done

for file in supabase/migrations/*.sql supabase/seed.sql; do
  [ -f "$file" ] || continue
  echo "applying $file"
  docker exec -i "$name" psql -U postgres -h 127.0.0.1 -q -v ON_ERROR_STOP=1 -f - <"$file"
done
echo "ready: postgresql://postgres:postgres@127.0.0.1:$port/postgres"
