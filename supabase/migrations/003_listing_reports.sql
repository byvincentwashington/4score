-- ============================================================
-- Scory — Migration 003: Listing Reports & Review Flags
-- ============================================================
-- What this adds:
--   • needs_review + review_reason columns on listings
--     (set by monitoring cron when persistent failures detected,
--      cleared by admin after fixing)
--   • listing_reports table — public reports from agents/users
--     flagging stale data, wrong endpoints, or other issues
-- ============================================================

-- ── Step 1: Review flags on listings ─────────────────────────────────────────
ALTER TABLE listings
  ADD COLUMN needs_review   boolean  DEFAULT false,
  ADD COLUMN review_reason  text;    -- e.g. 'persistent_monitoring_failure', 'reported_stale'

CREATE INDEX listings_needs_review_idx ON listings(needs_review) WHERE needs_review = true;

-- ── Step 2: listing_reports ───────────────────────────────────────────────────
-- Public, append-only. Agents or users flag listings they believe are outdated.
-- Never deleted — used for auditing and prioritising review queue.

CREATE TABLE listing_reports (
  id               uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id       uuid        NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  reporter_ip_hash text        NOT NULL,
  reason           text        NOT NULL
    CHECK (reason IN (
      'wrong_endpoint',    -- endpoint URL is incorrect or changed
      'stale_pricing',     -- pricing information is out of date
      'service_shutdown',  -- the service no longer exists
      'inaccurate_info',   -- description or capabilities are wrong
      'other'
    )),
  details          text,       -- optional free-text from reporter (max 500 chars)
  resolved         boolean     DEFAULT false,
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX listing_reports_listing_idx
  ON listing_reports(listing_id, created_at DESC);

CREATE INDEX listing_reports_unresolved_idx
  ON listing_reports(resolved, created_at DESC) WHERE resolved = false;

-- ── Step 3: RLS ───────────────────────────────────────────────────────────────
ALTER TABLE listing_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_full_access_listing_reports"
  ON listing_reports FOR ALL TO service_role USING (true) WITH CHECK (true);
