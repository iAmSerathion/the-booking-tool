-- OPTIONAL, not applied by migrations, db reset or the tests: run the scheduler from the database every minute with
-- pg_cron and pg_net. Use it instead of an external cron (see the README, "Scheduler"). Run it once in the SQL editor of
-- your Supabase project, after storing the two Vault secrets it reads (placeholders; put in your own values):
--
--   select vault.create_secret('<APP_URL>/api/jobs/scheduler', 'scheduler_url');
--   select vault.create_secret('<SCHEDULER_SECRET>', 'scheduler_secret');
--
-- To stop it: select cron.unschedule('booking-scheduler');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'booking-scheduler',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'scheduler_url'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'scheduler_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
