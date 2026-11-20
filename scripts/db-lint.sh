#!/usr/bin/env bash
# Local stand-in for `supabase db lint --fail-on error`: plpgsql_check over every plpgsql function in public.
set -euo pipefail
name=tbt-testdb
out=$(docker exec -i "$name" psql -U postgres -h 127.0.0.1 -q -At -v ON_ERROR_STOP=1 <<'SQL'
create extension if not exists plpgsql_check;
select p.oid::regprocedure || ': ' || r.message
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language l on l.oid = p.prolang
cross join lateral plpgsql_check_function_tb(p.oid) r
where n.nspname = 'public' and l.lanname = 'plpgsql' and p.prorettype <> 'trigger'::regtype and r.level = 'error';
SQL
)
if [ -n "$out" ]; then echo "$out"; exit 1; fi
echo "db lint: no errors"
