-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 004: Agent support + type-aware scoring
-- Adds listing_type ('service' | 'agent') to listings.
-- Agent-specific fields: model, provider, avg_task_duration_ms.
-- Blend weights become type-aware (agents flip the ratio — reputation > technical).
-- search_listings() gains a listing_type_filter parameter.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. ── New columns on listings ───────────────────────────────────────────────

ALTER TABLE listings
  ADD COLUMN listing_type         text    NOT NULL DEFAULT 'service'
    CHECK (listing_type IN ('service', 'agent')),
  ADD COLUMN model                text,       -- e.g. 'claude-3-5-sonnet', 'gpt-4o'
  ADD COLUMN provider             text,       -- e.g. 'Anthropic', 'OpenAI'
  ADD COLUMN avg_task_duration_ms integer;    -- populated via reputation events

-- Index for type-filtered queries
CREATE INDEX idx_listings_listing_type ON listings (listing_type);

-- 2. ── Type-aware blend function ─────────────────────────────────────────────
--
-- Services are monitoring-first:
--   <5 events  → 80% technical / 20% reputation
--   5–19       → 50% / 50%
--   20+        → 30% / 70%
--
-- Agents are reputation-first (task outcomes are the primary signal):
--   <5 events  → 40% technical / 60% reputation
--   5–19       → 25% / 75%
--   20+        → 15% / 85%

CREATE OR REPLACE FUNCTION update_blended_trust_score(p_listing_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_tech_score numeric;
  v_rep_score  numeric;
  v_blended    numeric;
  v_events     integer;
  v_tech_w     numeric;
  v_rep_w      numeric;
  v_type       text;
BEGIN
  -- Fetch technical score and listing type
  SELECT technical_trust_score, listing_type
  INTO   v_tech_score, v_type
  FROM   listings
  WHERE  id = p_listing_id;

  -- Fetch reputation score and total event volume
  SELECT
    reputation_score,
    (tasks_completed + tasks_failed + total_ratings + safety_incident_count)
  INTO v_rep_score, v_events
  FROM agent_reputation
  WHERE listing_id = p_listing_id;

  -- No reputation data yet — trust score equals technical score
  IF v_rep_score IS NULL THEN
    UPDATE listings
    SET trust_score = COALESCE(v_tech_score, 50)
    WHERE id = p_listing_id;
    RETURN;
  END IF;

  -- Type-aware blend weights
  IF v_type = 'agent' THEN
    IF    v_events < 5  THEN v_tech_w := 0.40; v_rep_w := 0.60;
    ELSIF v_events < 20 THEN v_tech_w := 0.25; v_rep_w := 0.75;
    ELSE                     v_tech_w := 0.15; v_rep_w := 0.85;
    END IF;
  ELSE  -- 'service'
    IF    v_events < 5  THEN v_tech_w := 0.80; v_rep_w := 0.20;
    ELSIF v_events < 20 THEN v_tech_w := 0.50; v_rep_w := 0.50;
    ELSE                     v_tech_w := 0.30; v_rep_w := 0.70;
    END IF;
  END IF;

  v_blended := ROUND(
    (COALESCE(v_tech_score, 50) * v_tech_w + v_rep_score * v_rep_w)::numeric,
    2
  );

  UPDATE listings
  SET trust_score = GREATEST(0, LEAST(100, v_blended))
  WHERE id = p_listing_id;
END;
$$;

-- 3. ── Rebuild search_listings with listing_type_filter ──────────────────────
--
-- Must DROP first because we're adding a parameter (changes the function signature).

DROP FUNCTION IF EXISTS search_listings(vector(1024), text, text[], text, numeric, boolean, boolean, integer, integer);

CREATE FUNCTION search_listings(
  query_embedding         vector(1024) DEFAULT NULL,
  category_slug_filter    text         DEFAULT NULL,
  capability_slug_filters text[]       DEFAULT NULL,
  pricing_type_filter     text         DEFAULT NULL,
  listing_type_filter     text         DEFAULT NULL,   -- 'service' | 'agent' | NULL (all)
  min_trust_score         numeric      DEFAULT 0,
  verified_only           boolean      DEFAULT false,
  include_sponsored       boolean      DEFAULT true,
  result_limit            integer      DEFAULT 10,
  result_offset           integer      DEFAULT 0
)
RETURNS TABLE (
  id                   uuid,
  name                 text,
  slug                 text,
  short_description    text,
  category_name        text,
  category_slug        text,
  capabilities         jsonb,
  trust_score          numeric,
  pricing_type         text,
  endpoint_url         text,
  auth_type            text,
  verification_status  text,
  sponsored            boolean,
  avg_response_time_ms integer,
  regions_supported    text[],
  listing_type         text,
  semantic_score       numeric,
  final_score          numeric,
  sponsored_rank       integer
)
LANGUAGE sql
STABLE
AS $$
  WITH
  -- ── Capability filter ──────────────────────────────────────────────────────
  cap_filter AS (
    SELECT DISTINCT lc.listing_id
    FROM   listing_capabilities lc
    JOIN   capabilities c ON c.id = lc.capability_id
    WHERE  c.slug = ANY(capability_slug_filters)
    GROUP  BY lc.listing_id
    HAVING COUNT(DISTINCT c.slug) = array_length(capability_slug_filters, 1)
  ),

  -- ── Base listing set ───────────────────────────────────────────────────────
  base AS (
    SELECT
      l.id,
      l.name,
      l.slug,
      l.short_description,
      cat.name                        AS category_name,
      cat.slug                        AS category_slug,
      l.trust_score,
      l.pricing_type,
      l.endpoint_url,
      l.auth_type,
      l.verification_status,
      l.sponsored,
      l.avg_response_time_ms,
      l.uptime_score,
      l.regions_supported,
      l.listing_type,
      l.embedding,
      COALESCE(l.sponsored_rank, 999) AS sponsored_rank,
      (
        SELECT jsonb_agg(jsonb_build_object('name', c2.name, 'slug', c2.slug))
        FROM   listing_capabilities lc2
        JOIN   capabilities c2 ON c2.id = lc2.capability_id
        WHERE  lc2.listing_id = l.id
      ) AS capabilities
    FROM  listings l
    JOIN  categories cat ON cat.id = l.category_id
    WHERE l.is_active = true
      AND l.trust_score          >= min_trust_score
      AND (category_slug_filter    IS NULL OR cat.slug        = category_slug_filter)
      AND (pricing_type_filter     IS NULL OR l.pricing_type  = pricing_type_filter)
      AND (listing_type_filter     IS NULL OR l.listing_type  = listing_type_filter)
      AND (NOT verified_only       OR l.verification_status  = 'verified')
      AND (include_sponsored       OR NOT l.sponsored)
      AND (capability_slug_filters IS NULL OR l.id IN (SELECT listing_id FROM cap_filter))
  ),

  -- ── Semantic scoring ───────────────────────────────────────────────────────
  scored AS (
    SELECT
      b.*,
      CASE
        WHEN query_embedding IS NOT NULL
          THEN ROUND((1 - (b.embedding <=> query_embedding))::numeric, 6)
        ELSE 0.5
      END AS semantic_score
    FROM base b
  ),

  -- ── Final ranking ──────────────────────────────────────────────────────────
  ranked AS (
    SELECT
      s.*,
      ROUND((
        CASE
          WHEN query_embedding IS NOT NULL THEN
              0.40 * s.semantic_score
            + 0.40 * (s.trust_score / 100.0)
            + 0.10 * COALESCE(s.uptime_score, 50) / 100.0
            + 0.10 * GREATEST(0, 1 - COALESCE(s.avg_response_time_ms, 500) / 2000.0)
          ELSE
              0.70 * (s.trust_score / 100.0)
            + 0.20 * COALESCE(s.uptime_score, 50) / 100.0
            + 0.10 * GREATEST(0, 1 - COALESCE(s.avg_response_time_ms, 500) / 2000.0)
        END
      )::numeric, 6) AS final_score
    FROM scored s
  )

  SELECT
    r.id,
    r.name,
    r.slug,
    r.short_description,
    r.category_name,
    r.category_slug,
    r.capabilities,
    r.trust_score,
    r.pricing_type,
    r.endpoint_url,
    r.auth_type,
    r.verification_status,
    r.sponsored,
    r.avg_response_time_ms,
    r.regions_supported,
    r.listing_type,
    r.semantic_score,
    r.final_score,
    r.sponsored_rank
  FROM   ranked r
  ORDER BY r.sponsored_rank ASC, r.final_score DESC
  LIMIT  result_limit
  OFFSET result_offset
$$;
