-- Run once by the Postgres image after its init (mounted as /etc/postgresql.schema.sql): login passwords for the
-- service roles GoTrue and PostgREST connect with. Local stack only, never published beyond 127.0.0.1.
alter role authenticator with password 'postgres';
alter role supabase_auth_admin with password 'postgres';
