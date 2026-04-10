-- ============================================================
-- AgentDir — Migration 002: Reputation & Trust Scoring Layer
-- ============================================================

-- ── Step 1: Add technical_trust_score to listings ───────────────────────────
ALTER TABLE listings
  ADD COLUMN technical_trust_score numeric(5,2) DEFAULT 50.00
    CHECK (technical_trust_score BETWEEN 0 AND 100);

UPDATE listings SET technical_trust_score = trust_score;

-- ── Step 2: agent_reputation ─────────────────────────────────────────────────
CREATE TABLE agent_reputation (
  id                    uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id            uuid        NOT NULL UNIQUE REFERENCES listings(id) ON DELETE CASCADE,
  total_transactions    integer     NOT NULL DEFAULT 0,
  tasks_completed       integer     NOT NULL DEFAULT 0,
  tasks_failed          integer     NOT NULL DEFAULT 0,
  task_completion_rate  numeric(5,4)
    CHECK (task_completion_rate BETWEEN 0 AND 1),
  avg_cost_efficiency   numeric(5,2)
    CHECK (avg_cost_efficiency BETWEEN 0 AND 100),
  safety_incident_count integer     NOT NULL DEFAULT 0,
  avg_user_rating       numeric(3,2)
    CHECK (avg_user_rating BETWEEN 1 AND 5),
  total_ratings         integer     NOT NULL DEFAULT 0,
  reputation_score      numeric(5,2)
    CHECK (reputation_score BETWEEN 0 AND 100),
  last_calculated_at    timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ── Step 3: reputation_events ────────────────────────────────────────────────
CREATE TABLE reputation_events (
  id               uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id       uuid        NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  reporter_ip_hash text        NOT NULL,
  event_type       text        NOT NULL
    CHECK (event_type IN (
      'task_completed',
      'task_failed',
      'overspend',
      'safety_flag',
      'user_rating'
    )),
  value            numeric,
  weight           numeric(6,5) NOT NULL DEFAULT 1.0,
  metadata         jsonb        NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ── Step 4: Indexes ───────────────────────────────────────────────────────────
CREATE INDEX agent_reputation_listing_idx
  ON agent_reputation(listing_id);

CREATE INDEX agent_reputation_score_idx
  ON agent_reputation(reputation_score DESC NULLS LAST);

CREATE INDEX reputation_events_listing_idx
  ON reputation_events(listing_id, created_at DESC);

CREATE INDEX reputation_events_type_idx
  ON reputation_events(listing_id, event_type, created_at DESC);

CREATE INDEX reputation_events_ip_listing_idx
  ON reputation_events(reporter_ip_hash, listing_id, event_type, created_at DESC);

-- ── Step 5: recalculate_reputation() ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION recalculate_reputation(p_listing_id uuid)
RETURNS void AS $$
DECLARE
  v_decay_rate        constant numeric := 0.02310;
  v_w_completed       numeric := 0;
  v_w_failed          numeric := 0;
  v_w_rating_sum      numeric := 0;
  v_w_rating_weight   numeric := 0;
  v_w_cost_sum        numeric := 0;
  v_w_cost_weight     numeric := 0;
  v_safety_recent     integer := 0;
  v_total_completed   integer := 0;
  v_total_failed      integer := 0;
  v_total_ratings     integer := 0;
  v_total_cost_events integer := 0;
  v_completion_score  numeric := 50;
  v_rating_score      numeric := 50;
  v_cost_score        numeric := 50;
  v_volume_score      numeric := 0;
  v_base_score        numeric;
  v_safety_penalty    numeric;
  v_reputation_score  numeric;
  v_total_transactions integer;
  v_completion_rate   numeric;
  v_avg_rating        numeric;
  v_avg_cost          numeric;
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT
      event_type,
      value,
      weight,
      created_at,
      EXP(-v_decay_rate * EXTRACT(EPOCH FROM (now() - created_at)) / 86400.0) AS decay_factor
    FROM reputation_events
    WHERE listing_id = p_listing_id
    ORDER BY created_at DESC
  LOOP
    CASE rec.event_type
      WHEN 'task_completed' THEN
        v_w_completed     := v_w_completed + (rec.weight * rec.decay_factor);
        v_total_completed := v_total_completed + 1;
      WHEN 'task_failed' THEN
        v_w_failed     := v_w_failed + (rec.weight * rec.decay_factor);
        v_total_failed := v_total_failed + 1;
      WHEN 'user_rating' THEN
        IF rec.value IS NOT NULL AND rec.value BETWEEN 1 AND 5 THEN
          v_w_rating_sum    := v_w_rating_sum + (rec.value * rec.weight * rec.decay_factor);
          v_w_rating_weight := v_w_rating_weight + (rec.weight * rec.decay_factor);
          v_total_ratings   := v_total_ratings + 1;
        END IF;
      WHEN 'overspend' THEN
        IF rec.value IS NOT NULL AND rec.value BETWEEN 0 AND 100 THEN
          v_w_cost_sum        := v_w_cost_sum + (rec.value * rec.weight * rec.decay_factor);
          v_w_cost_weight     := v_w_cost_weight + (rec.weight * rec.decay_factor);
          v_total_cost_events := v_total_cost_events + 1;
        END IF;
      ELSE NULL;
    END CASE;
  END LOOP;

  SELECT COUNT(*) INTO v_safety_recent
  FROM reputation_events
  WHERE listing_id = p_listing_id
    AND event_type = 'safety_flag'
    AND created_at >= now() - INTERVAL '90 days';

  v_total_transactions := v_total_completed + v_total_failed;

  IF (v_w_completed + v_w_failed) > 0 THEN
    v_completion_score := (v_w_completed / (v_w_completed + v_w_failed)) * 100;
    v_completion_rate  := v_total_completed::numeric / v_total_transactions;
  ELSE
    v_completion_score := 50;
    v_completion_rate  := NULL;
  END IF;

  IF v_w_rating_weight > 0 THEN
    v_avg_rating   := v_w_rating_sum / v_w_rating_weight;
    v_rating_score := ((v_avg_rating - 1) / 4.0) * 100;
  ELSE
    v_rating_score := 50;
    v_avg_rating   := NULL;
  END IF;

  IF v_w_cost_weight > 0 THEN
    v_cost_score := v_w_cost_sum / v_w_cost_weight;
    v_avg_cost   := v_cost_score;
  ELSE
    v_cost_score := 50;
    v_avg_cost   := NULL;
  END IF;

  v_volume_score := LEAST(10, v_total_transactions::numeric / 5.0);

  v_base_score :=
    (v_completion_score * 0.40) +
    (v_rating_score     * 0.30) +
    (v_cost_score       * 0.20) +
    (v_volume_score     * 1.00);

  v_safety_penalty   := LEAST(50, v_safety_recent * 15);
  v_reputation_score := GREATEST(0, LEAST(100, v_base_score - v_safety_penalty));

  INSERT INTO agent_reputation (
    listing_id, total_transactions, tasks_completed, tasks_failed,
    task_completion_rate, avg_cost_efficiency, safety_incident_count,
    avg_user_rating, total_ratings, reputation_score, last_calculated_at
  ) VALUES (
    p_listing_id, v_total_transactions, v_total_completed, v_total_failed,
    v_completion_rate, v_avg_cost,
    (SELECT COUNT(*) FROM reputation_events
     WHERE listing_id = p_listing_id AND event_type = 'safety_flag'),
    v_avg_rating, v_total_ratings,
    ROUND(v_reputation_score::numeric, 2), now()
  )
  ON CONFLICT (listing_id) DO UPDATE SET
    total_transactions    = EXCLUDED.total_transactions,
    tasks_completed       = EXCLUDED.tasks_completed,
    tasks_failed          = EXCLUDED.tasks_failed,
    task_completion_rate  = EXCLUDED.task_completion_rate,
    avg_cost_efficiency   = EXCLUDED.avg_cost_efficiency,
    safety_incident_count = EXCLUDED.safety_incident_count,
    avg_user_rating       = EXCLUDED.avg_user_rating,
    total_ratings         = EXCLUDED.total_ratings,
    reputation_score      = EXCLUDED.reputation_score,
    last_calculated_at    = EXCLUDED.last_calculated_at,
    updated_at            = now();

  PERFORM update_blended_trust_score(p_listing_id);
END;
$$ LANGUAGE plpgsql;

-- ── Step 6: update_blended_trust_score() ─────────────────────────────────────
CREATE OR REPLACE FUNCTION update_blended_trust_score(p_listing_id uuid)
RETURNS void AS $$
DECLARE
  v_technical_score  numeric;
  v_reputation_score numeric;
  v_total_events     integer;
  v_tech_weight      numeric;
  v_rep_weight       numeric;
  v_blended_score    numeric;
BEGIN
  SELECT technical_trust_score INTO v_technical_score
  FROM listings WHERE id = p_listing_id;

  SELECT reputation_score,
         (tasks_completed + tasks_failed + total_ratings + safety_incident_count)
  INTO v_reputation_score, v_total_events
  FROM agent_reputation WHERE listing_id = p_listing_id;

  IF v_reputation_score IS NULL THEN
    UPDATE listings SET trust_score = v_technical_score WHERE id = p_listing_id;
    RETURN;
  END IF;

  IF v_total_events < 5 THEN
    v_tech_weight := 0.80;
    v_rep_weight  := 0.20;
  ELSIF v_total_events < 20 THEN
    v_tech_weight := 0.50;
    v_rep_weight  := 0.50;
  ELSE
    v_tech_weight := 0.30;
    v_rep_weight  := 0.70;
  END IF;

  v_blended_score := (v_technical_score * v_tech_weight) +
                     (v_reputation_score * v_rep_weight);

  UPDATE listings
  SET trust_score = ROUND(LEAST(100, GREATEST(0, v_blended_score))::numeric, 2)
  WHERE id = p_listing_id;
END;
$$ LANGUAGE plpgsql;

-- ── Step 7: Update update_listing_trust_score() ──────────────────────────────
CREATE OR REPLACE FUNCTION update_listing_trust_score(p_listing_id uuid)
RETURNS void AS $$
DECLARE
  v_uptime_pct        numeric;
  v_avg_response_ms   numeric;
  v_error_rate        numeric;
  v_ssl_valid         boolean;
  v_schema_compliance numeric;
  v_technical_score   numeric;
BEGIN
  SELECT
    (COUNT(*) FILTER (WHERE is_up)::numeric / NULLIF(COUNT(*), 0)) * 100,
    AVG(response_time_ms) FILTER (WHERE is_up AND response_time_ms IS NOT NULL),
    (COUNT(*) FILTER (WHERE NOT is_up)::numeric / NULLIF(COUNT(*), 0)),
    bool_and(ssl_valid),
    (COUNT(*) FILTER (WHERE schema_valid)::numeric
      / NULLIF(COUNT(*) FILTER (WHERE is_up), 0)) * 100
  INTO v_uptime_pct, v_avg_response_ms, v_error_rate, v_ssl_valid, v_schema_compliance
  FROM (
    SELECT * FROM monitoring_logs
    WHERE listing_id = p_listing_id
    ORDER BY checked_at DESC
    LIMIT 100
  ) recent_checks;

  v_technical_score := (
    (COALESCE(v_uptime_pct, 50)                                        * 0.35) +
    (GREATEST(0, 100 - COALESCE(v_avg_response_ms, 500) / 10.0)       * 0.25) +
    ((1 - COALESCE(v_error_rate, 0.5)) * 100                          * 0.25) +
    (CASE WHEN COALESCE(v_ssl_valid, false) THEN 100 ELSE 0 END       * 0.05) +
    (COALESCE(v_schema_compliance, 50)                                 * 0.10)
  );

  UPDATE listings SET
    technical_trust_score   = ROUND(LEAST(100, GREATEST(0, v_technical_score))::numeric, 2),
    uptime_score            = ROUND(COALESCE(v_uptime_pct, uptime_score)::numeric, 2),
    avg_response_time_ms    = COALESCE(v_avg_response_ms::integer, avg_response_time_ms),
    error_rate              = ROUND(COALESCE(v_error_rate, error_rate)::numeric, 5),
    ssl_valid               = COALESCE(v_ssl_valid, ssl_valid),
    schema_compliance_score = ROUND(COALESCE(v_schema_compliance, schema_compliance_score)::numeric, 2),
    last_monitored_at       = now()
  WHERE id = p_listing_id;

  PERFORM update_blended_trust_score(p_listing_id);
END;
$$ LANGUAGE plpgsql;

-- ── Step 8: RLS ───────────────────────────────────────────────────────────────
ALTER TABLE agent_reputation  ENABLE ROW LEVEL SECURITY;
ALTER TABLE reputation_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_read_agent_reputation"
  ON agent_reputation FOR SELECT TO anon USING (true);

CREATE POLICY "service_full_access_agent_reputation"
  ON agent_reputation FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_full_access_reputation_events"
  ON reputation_events FOR ALL TO service_role USING (true) WITH CHECK (true);
