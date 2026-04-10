-- ============================================================
-- AgentDir — Initial Schema
-- Supabase / PostgreSQL + pgvector
-- Embeddings: Voyage AI voyage-3 (1024 dimensions)
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================
-- CATEGORIES  (predefined taxonomy, admin-managed)
-- ============================================================
CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        text NOT NULL UNIQUE,
  slug        text NOT NULL UNIQUE,
  description text,
  icon        text,                       -- emoji or icon name for future UI
  created_at  timestamptz DEFAULT now()
);

-- ============================================================
-- CAPABILITIES  (predefined taxonomy, admin-managed)
-- ============================================================
CREATE TABLE capabilities (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        text NOT NULL UNIQUE,
  slug        text NOT NULL UNIQUE,
  description text,
  created_at  timestamptz DEFAULT now()
);

-- ============================================================
-- BUSINESS ACCOUNTS  (claimed listing owners)
-- ============================================================
CREATE TABLE business_accounts (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  email            text NOT NULL UNIQUE,
  company_name     text NOT NULL,
  contact_name     text,
  api_key_hash     text NOT NULL UNIQUE,  -- bcrypt hash of the issued key
  api_key_prefix   text NOT NULL,         -- first 12 chars shown in dashboard (e.g. "sk_ba_ab12cd34")
  plan             text NOT NULL DEFAULT 'starter'
                     CHECK (plan IN ('starter', 'growth', 'enterprise')),
  billing_email    text,
  stripe_customer_id text,               -- placeholder for Stripe integration
  is_active        boolean DEFAULT true,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

-- ============================================================
-- LISTINGS  (core service/API/tool records)
-- ============================================================
CREATE TABLE listings (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                text NOT NULL,
  slug                text NOT NULL UNIQUE,

  -- Descriptions
  short_description   text NOT NULL CHECK (char_length(short_description) <= 280),
  description         text NOT NULL,

  -- Endpoints
  endpoint_url        text NOT NULL,
  documentation_url   text,
  website_url         text,

  -- Classification
  category_id         uuid NOT NULL REFERENCES categories(id),
  tags                text[] DEFAULT '{}',

  -- Pricing
  pricing_type        text NOT NULL
                        CHECK (pricing_type IN ('free', 'freemium', 'paid', 'usage_based', 'contact')),
  pricing_details     jsonb DEFAULT '{}',
  -- pricing_details shape example:
  -- { "per_call_usd": 0.001, "monthly_plans": [{ "name": "Starter", "usd": 9, "calls": 10000 }] }

  -- Auth
  auth_type           text NOT NULL DEFAULT 'api_key'
                        CHECK (auth_type IN ('none', 'api_key', 'oauth2', 'bearer', 'basic')),

  -- Quality signals (written by monitoring cron job)
  trust_score              numeric(5,2)  DEFAULT 50.00 CHECK (trust_score BETWEEN 0 AND 100),
  uptime_score             numeric(5,2)  DEFAULT 50.00 CHECK (uptime_score BETWEEN 0 AND 100),
  avg_response_time_ms     integer,
  error_rate               numeric(6,5)  DEFAULT 0     CHECK (error_rate BETWEEN 0 AND 1),
  ssl_valid                boolean       DEFAULT true,
  schema_compliance_score  numeric(5,2)  DEFAULT 50.00 CHECK (schema_compliance_score BETWEEN 0 AND 100),
  last_monitored_at        timestamptz,

  -- Verification & placement
  verification_status text NOT NULL DEFAULT 'unverified'
                        CHECK (verification_status IN ('unverified', 'pending', 'verified')),
  featured            boolean  DEFAULT false,
  sponsored           boolean  DEFAULT false,
  sponsored_rank      integer,           -- lower number = higher sponsored placement

  -- Ownership
  claimed             boolean  DEFAULT false,
  business_account_id uuid     REFERENCES business_accounts(id),

  -- Global reach
  languages_supported text[]   DEFAULT ARRAY['en'],
  regions_supported   text[]   DEFAULT ARRAY['global'],

  -- Semantic search embedding (voyage-3 = 1024 dims)
  embedding           vector(1024),

  -- Response JSON Schema for monitoring validation (optional)
  response_schema     jsonb,

  -- Stats
  impression_count    integer  DEFAULT 0,

  -- Admin
  is_active           boolean  DEFAULT true,
  submitted_by        text,              -- email of admin/submitter
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

-- ============================================================
-- LISTING_CAPABILITIES  (many-to-many join)
-- ============================================================
CREATE TABLE listing_capabilities (
  listing_id    uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  capability_id uuid NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  PRIMARY KEY (listing_id, capability_id)
);

-- ============================================================
-- MONITORING_LOGS  (one row per synthetic ping)
-- ============================================================
CREATE TABLE monitoring_logs (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id       uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  checked_at       timestamptz DEFAULT now(),
  is_up            boolean NOT NULL,
  response_time_ms integer,
  http_status_code integer,
  ssl_valid        boolean,
  schema_valid     boolean,
  error_message    text,
  raw_response     jsonb      -- stored for debugging; scrubbed after 30 days by cron
);

-- ============================================================
-- QUERY_LOGS  (agent query tracking — no raw IPs stored)
-- ============================================================
CREATE TABLE query_logs (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  query_text      text,
  ip_hash         text,        -- SHA-256 of client IP; never raw IP
  result_count    integer,
  filters_applied jsonb DEFAULT '{}',
  created_at      timestamptz DEFAULT now()
);

-- ============================================================
-- IMPRESSION_LOGS  (which listings appeared in which query)
-- ============================================================
CREATE TABLE impression_logs (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  query_log_id   uuid REFERENCES query_logs(id) ON DELETE SET NULL,
  listing_id     uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  rank_position  integer NOT NULL,
  sponsored      boolean DEFAULT false,
  semantic_score numeric(7,5),
  final_score    numeric(7,5),
  created_at     timestamptz DEFAULT now()
);

-- ============================================================
-- INDEXES
-- ============================================================

-- HNSW vector index for fast approximate nearest-neighbor search
CREATE INDEX listings_embedding_hnsw_idx ON listings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Structured filter indexes
CREATE INDEX listings_category_id_idx        ON listings(category_id);
CREATE INDEX listings_trust_score_idx        ON listings(trust_score DESC);
CREATE INDEX listings_verification_idx       ON listings(verification_status);
CREATE INDEX listings_is_active_idx          ON listings(is_active);
CREATE INDEX listings_sponsored_idx          ON listings(sponsored, sponsored_rank NULLS LAST);
CREATE INDEX listings_pricing_type_idx       ON listings(pricing_type);
CREATE INDEX listings_claimed_idx            ON listings(claimed);

-- Monitoring & impression lookups
CREATE INDEX monitoring_logs_listing_idx     ON monitoring_logs(listing_id, checked_at DESC);
CREATE INDEX impression_logs_listing_idx     ON impression_logs(listing_id, created_at DESC);
CREATE INDEX impression_logs_query_idx       ON impression_logs(query_log_id);
CREATE INDEX query_logs_ip_hash_idx          ON query_logs(ip_hash, created_at DESC);
CREATE INDEX query_logs_created_at_idx       ON query_logs(created_at DESC);

-- ============================================================
-- TRIGGER: auto-increment impression_count on listings
-- ============================================================
CREATE OR REPLACE FUNCTION increment_impression_count()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE listings SET impression_count = impression_count + 1 WHERE id = NEW.listing_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_increment_impression
  AFTER INSERT ON impression_logs
  FOR EACH ROW EXECUTE FUNCTION increment_impression_count();

-- ============================================================
-- TRIGGER: updated_at auto-timestamp
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_listings_updated_at
  BEFORE UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_business_accounts_updated_at
  BEFORE UPDATE ON business_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- FUNCTION: update_listing_trust_score
-- Called by monitoring cron after each batch of pings.
-- Weighs: uptime 35% | speed 25% | error-free 25% | SSL 5% | schema 10%
-- ============================================================
CREATE OR REPLACE FUNCTION update_listing_trust_score(p_listing_id uuid)
RETURNS void AS $$
DECLARE
  v_uptime_pct        numeric;
  v_avg_response_ms   numeric;
  v_error_rate        numeric;
  v_ssl_valid         boolean;
  v_schema_compliance numeric;
  v_trust_score       numeric;
BEGIN
  SELECT
    -- uptime: % of pings that returned is_up = true
    (COUNT(*) FILTER (WHERE is_up)::numeric / NULLIF(COUNT(*), 0)) * 100,
    -- average response time (ms) for successful pings only
    AVG(response_time_ms) FILTER (WHERE is_up AND response_time_ms IS NOT NULL),
    -- error rate: fraction of pings that failed
    (COUNT(*) FILTER (WHERE NOT is_up)::numeric / NULLIF(COUNT(*), 0)),
    -- ssl: true only if ALL recent pings had valid SSL
    bool_and(ssl_valid),
    -- schema compliance: % of successful pings with valid schema
    (COUNT(*) FILTER (WHERE schema_valid)::numeric
      / NULLIF(COUNT(*) FILTER (WHERE is_up), 0)) * 100
  INTO
    v_uptime_pct, v_avg_response_ms, v_error_rate, v_ssl_valid, v_schema_compliance
  FROM (
    SELECT * FROM monitoring_logs
    WHERE listing_id = p_listing_id
    ORDER BY checked_at DESC
    LIMIT 100
  ) recent_checks;

  -- Score components (all normalised to 0-100):
  --   uptime_score      = v_uptime_pct (already 0-100)
  --   speed_score       = 100 - capped penalty based on response time
  --                       1000ms baseline → 0pts; 100ms → ~90pts; 50ms → 95pts
  --   error_free_score  = (1 - error_rate) * 100
  --   ssl_score         = 100 if valid, else 0
  --   schema_score      = v_schema_compliance (already 0-100)
  v_trust_score := (
    (COALESCE(v_uptime_pct, 50)                                          * 0.35) +
    (GREATEST(0, 100 - COALESCE(v_avg_response_ms, 500) / 10.0)         * 0.25) +
    ((1 - COALESCE(v_error_rate, 0.5)) * 100                            * 0.25) +
    (CASE WHEN COALESCE(v_ssl_valid, false) THEN 100 ELSE 0 END         * 0.05) +
    (COALESCE(v_schema_compliance, 50)                                   * 0.10)
  );

  UPDATE listings SET
    trust_score             = ROUND(LEAST(100, GREATEST(0, v_trust_score))::numeric, 2),
    uptime_score            = ROUND(COALESCE(v_uptime_pct, uptime_score)::numeric, 2),
    avg_response_time_ms    = COALESCE(v_avg_response_ms::integer, avg_response_time_ms),
    error_rate              = ROUND(COALESCE(v_error_rate, error_rate)::numeric, 5),
    ssl_valid               = COALESCE(v_ssl_valid, ssl_valid),
    schema_compliance_score = ROUND(COALESCE(v_schema_compliance, schema_compliance_score)::numeric, 2),
    last_monitored_at       = now()
  WHERE id = p_listing_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- FUNCTION: search_listings (hybrid semantic + structured)
-- Called by the Express query route.
-- Ranking: semantic similarity 40% | trust 40% | uptime 10% | speed 10%
-- Sponsored listings are injected at the top regardless of score.
-- ============================================================
CREATE OR REPLACE FUNCTION search_listings(
  query_embedding          vector(1024)  DEFAULT NULL,
  category_slug_filter     text          DEFAULT NULL,
  capability_slug_filters  text[]        DEFAULT NULL,
  pricing_type_filter      text          DEFAULT NULL,
  min_trust_score          numeric       DEFAULT 0,
  verified_only            boolean       DEFAULT false,
  include_sponsored        boolean       DEFAULT true,
  result_limit             integer       DEFAULT 10,
  result_offset            integer       DEFAULT 0
)
RETURNS TABLE (
  id                  uuid,
  name                text,
  slug                text,
  short_description   text,
  category_name       text,
  category_slug       text,
  capabilities        text[],
  trust_score         numeric,
  uptime_score        numeric,
  avg_response_time_ms integer,
  pricing_type        text,
  pricing_details     jsonb,
  endpoint_url        text,
  auth_type           text,
  verification_status text,
  sponsored           boolean,
  sponsored_rank      integer,
  impression_count    integer,
  regions_supported   text[],
  languages_supported text[],
  semantic_score      numeric,
  final_score         numeric
) AS $$
BEGIN
  RETURN QUERY
  WITH

  -- Filter listings that have ALL requested capabilities
  cap_match AS (
    SELECT lc.listing_id
    FROM listing_capabilities lc
    JOIN capabilities c ON c.id = lc.capability_id
    WHERE
      capability_slug_filters IS NOT NULL
      AND c.slug = ANY(capability_slug_filters)
    GROUP BY lc.listing_id
    HAVING COUNT(DISTINCT c.slug) = array_length(capability_slug_filters, 1)
  ),

  scored AS (
    SELECT
      l.id,
      l.name,
      l.slug,
      l.short_description,
      cat.name                                              AS category_name,
      cat.slug                                              AS category_slug,
      ARRAY(
        SELECT c2.slug
        FROM listing_capabilities lc2
        JOIN capabilities c2 ON c2.id = lc2.capability_id
        WHERE lc2.listing_id = l.id
        ORDER BY c2.name
      )                                                     AS capabilities,
      l.trust_score,
      l.uptime_score,
      l.avg_response_time_ms,
      l.pricing_type,
      l.pricing_details,
      l.endpoint_url,
      l.auth_type,
      l.verification_status,
      l.sponsored,
      COALESCE(l.sponsored_rank, 999)                       AS sponsored_rank,
      l.impression_count,
      l.regions_supported,
      l.languages_supported,

      -- Semantic score: 1 = perfect match, 0 = unrelated
      -- Falls back to 0.5 when no query embedding is provided
      CASE
        WHEN query_embedding IS NOT NULL
        THEN (1 - (l.embedding <=> query_embedding))
        ELSE 0.5
      END::numeric                                          AS semantic_score,

      -- Final ranking score
      CASE
        WHEN query_embedding IS NOT NULL THEN (
          (l.trust_score / 100.0 * 0.40) +
          ((1 - (l.embedding <=> query_embedding)) * 0.40) +
          (l.uptime_score / 100.0 * 0.10) +
          -- speed score: 0ms → 1.0, 1000ms → 0.5, 5000ms → ~0.17
          (1.0 / (1.0 + COALESCE(l.avg_response_time_ms, 500)::numeric / 1000.0) * 0.10)
        )
        ELSE (
          (l.trust_score / 100.0 * 0.70) +
          (l.uptime_score / 100.0 * 0.20) +
          (1.0 / (1.0 + COALESCE(l.avg_response_time_ms, 500)::numeric / 1000.0) * 0.10)
        )
      END::numeric                                          AS final_score

    FROM listings l
    JOIN categories cat ON cat.id = l.category_id

    WHERE
      l.is_active = true
      AND (query_embedding IS NULL OR l.embedding IS NOT NULL)
      AND (category_slug_filter IS NULL    OR cat.slug = category_slug_filter)
      AND (pricing_type_filter IS NULL     OR l.pricing_type = pricing_type_filter)
      AND l.trust_score >= min_trust_score
      AND (NOT verified_only               OR l.verification_status = 'verified')
      AND (include_sponsored               OR NOT l.sponsored)
      AND (
        capability_slug_filters IS NULL
        OR l.id IN (SELECT listing_id FROM cap_match)
      )
  )

  SELECT *
  FROM scored
  ORDER BY
    CASE WHEN scored.sponsored THEN 0 ELSE 1 END ASC,
    scored.sponsored_rank ASC NULLS LAST,
    scored.final_score DESC
  LIMIT result_limit
  OFFSET result_offset;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- ROW LEVEL SECURITY
-- Public can read active listings, categories, capabilities.
-- Writes are restricted to service role (backend only).
-- ============================================================
ALTER TABLE listings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories          ENABLE ROW LEVEL SECURITY;
ALTER TABLE capabilities        ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_accounts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring_logs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE query_logs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE impression_logs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_capabilities ENABLE ROW LEVEL SECURITY;

-- Anon read access for public tables
CREATE POLICY "public_read_listings"
  ON listings FOR SELECT TO anon USING (is_active = true);

CREATE POLICY "public_read_categories"
  ON categories FOR SELECT TO anon USING (true);

CREATE POLICY "public_read_capabilities"
  ON capabilities FOR SELECT TO anon USING (true);

CREATE POLICY "public_read_listing_capabilities"
  ON listing_capabilities FOR SELECT TO anon USING (true);

-- Service role has full access to everything (backend uses service key)
CREATE POLICY "service_full_access_listings"
  ON listings FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_full_access_business_accounts"
  ON business_accounts FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_full_access_monitoring_logs"
  ON monitoring_logs FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_full_access_query_logs"
  ON query_logs FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_full_access_impression_logs"
  ON impression_logs FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_full_access_listing_capabilities"
  ON listing_capabilities FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_full_access_categories"
  ON categories FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_full_access_capabilities"
  ON capabilities FOR ALL TO service_role USING (true) WITH CHECK (true);
