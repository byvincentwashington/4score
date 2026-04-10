-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 005: pg_cron scheduling for Edge Function monitoring
--
-- Enables pg_net (HTTP from Postgres) and pg_cron (scheduled jobs).
-- Schedules the monitor Edge Function to run every hour.
--
-- Run AFTER deploying the monitor Edge Function to Supabase.
-- Replace qjozqwsclgrzdbmbtphq with your actual Supabase project reference.
-- Replace 4score-cron-x9k2mP7qLtNvRwJ4 with the secret you set in Edge Function env vars.
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Grant pg_cron usage to postgres role
GRANT USAGE ON SCHEMA cron TO postgres;

-- ── Hourly monitoring cron ────────────────────────────────────────────────────
-- Calls the monitor Edge Function every hour at :00
-- Adjust the URL and secret before running.

SELECT cron.schedule(
  '4score-monitor-hourly',          -- job name (unique)
  '0 * * * *',                      -- every hour on the hour
  $$
    SELECT net.http_post(
      url     := 'https://qjozqwsclgrzdbmbtphq.supabase.co/functions/v1/monitor',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer 4score-cron-x9k2mP7qLtNvRwJ4'
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- ── Daily scrub cron ──────────────────────────────────────────────────────────
-- Nulls raw_response from monitoring_logs older than 30 days.
-- Keeps the table lean — raw responses are only for short-term debugging.

SELECT cron.schedule(
  '4score-scrub-daily',
  '0 3 * * *',                      -- 03:00 UTC every day
  $$
    UPDATE monitoring_logs
    SET raw_response = NULL
    WHERE checked_at < NOW() - INTERVAL '30 days'
      AND raw_response IS NOT NULL;
  $$
);
