import supabase from '../db/supabase.js';

// ── Event type config ────────────────────────────────────────────────────────
// Defines validation rules and rate-limit behaviour per event type.
//
// one_per_ip: true  → a given IP can only submit this event type once per listing, ever
// one_per_ip: false → one per listing per IP per 24 hours
// value_required: true → the `value` field must be present and within range
// value_range: [min, max] → inclusive bounds for value

const EVENT_CONFIG = {
  task_completed: { one_per_ip: false, value_required: false },
  task_failed:    { one_per_ip: false, value_required: false },
  overspend:      { one_per_ip: false, value_required: true,  value_range: [0, 100] },
  safety_flag:    { one_per_ip: false, value_required: false },
  user_rating:    { one_per_ip: true,  value_required: true,  value_range: [1, 5]   },
};

// ── submitReputationEvent ────────────────────────────────────────────────────

/**
 * Validate, persist, and score a single reputation event.
 *
 * @param {object} params
 * @param {string}  params.listing_id   UUID of the listing being rated
 * @param {string}  params.event_type   One of the EVENT_CONFIG keys
 * @param {number}  [params.value]      Required for overspend and user_rating
 * @param {object}  [params.metadata]   Optional structured context
 * @param {string}  params.reporter_ip  Raw IP (hashed before storage)
 *
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function submitReputationEvent({
  listing_id,
  event_type,
  value,
  metadata = {},
  reporter_ip,
}) {
  const config = EVENT_CONFIG[event_type];

  // ── Validate event_type ──────────────────────────────────────────────────
  if (!config) {
    return { ok: false, status: 400, message: `Invalid event_type. Valid values: ${Object.keys(EVENT_CONFIG).join(', ')}` };
  }

  // ── Validate value ───────────────────────────────────────────────────────
  if (config.value_required) {
    if (value === undefined || value === null) {
      return { ok: false, status: 400, message: `event_type "${event_type}" requires a value` };
    }
    const [min, max] = config.value_range;
    const num = Number(value);
    if (isNaN(num) || num < min || num > max) {
      return { ok: false, status: 400, message: `value for "${event_type}" must be between ${min} and ${max}` };
    }
  }

  // ── Confirm listing exists and is active ─────────────────────────────────
  const { data: listing, error: listingErr } = await supabase
    .from('listings')
    .select('id')
    .eq('id', listing_id)
    .eq('is_active', true)
    .single();

  if (listingErr || !listing) {
    return { ok: false, status: 404, message: 'Listing not found' };
  }

  // ── Hash reporter IP ─────────────────────────────────────────────────────
  const { createHash } = await import('crypto');
  const reporter_ip_hash = createHash('sha256').update(reporter_ip || 'unknown').digest('hex');

  // ── Rate limiting ────────────────────────────────────────────────────────
  if (config.one_per_ip) {
    // e.g. user_rating: only one per listing per IP, ever
    const { count } = await supabase
      .from('reputation_events')
      .select('id', { count: 'exact', head: true })
      .eq('listing_id', listing_id)
      .eq('reporter_ip_hash', reporter_ip_hash)
      .eq('event_type', event_type);

    if (count > 0) {
      return { ok: false, status: 429, message: `You have already submitted a "${event_type}" for this listing` };
    }
  } else {
    // All other types: one per listing per IP per 24 hours
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from('reputation_events')
      .select('id', { count: 'exact', head: true })
      .eq('listing_id', listing_id)
      .eq('reporter_ip_hash', reporter_ip_hash)
      .eq('event_type', event_type)
      .gte('created_at', since);

    if (count > 0) {
      return { ok: false, status: 429, message: `You have already submitted a "${event_type}" for this listing in the last 24 hours` };
    }
  }

  // ── Insert event ─────────────────────────────────────────────────────────
  const { error: insertErr } = await supabase
    .from('reputation_events')
    .insert({
      listing_id,
      reporter_ip_hash,
      event_type,
      value:    value !== undefined ? Number(value) : null,
      metadata: metadata || {},
    });

  if (insertErr) throw insertErr;

  // ── Trigger recalculation (non-blocking) ─────────────────────────────────
  // Fire-and-forget — the score update happens asynchronously so the
  // API response is fast. The score will be fresh within milliseconds.
  supabase.rpc('recalculate_reputation', { p_listing_id: listing_id })
    .then(({ error }) => {
      if (error) console.error('[reputation] Recalc failed:', error.message);
    });

  return { ok: true, status: 201, message: 'Event recorded. Trust score updated.' };
}

// ── getReputation ─────────────────────────────────────────────────────────────

/**
 * Fetch the current reputation record and score breakdown for a listing.
 *
 * @param {string} listing_id  UUID
 * @returns {Promise<object|null>}
 */
export async function getReputation(listing_id) {
  // Fetch reputation record and listing trust scores in parallel
  const [repResult, listingResult] = await Promise.all([
    supabase
      .from('agent_reputation')
      .select('*')
      .eq('listing_id', listing_id)
      .single(),
    supabase
      .from('listings')
      .select('id, name, slug, listing_type, trust_score, technical_trust_score')
      .eq('id', listing_id)
      .eq('is_active', true)
      .single(),
  ]);

  if (listingResult.error) {
    if (listingResult.error.code === 'PGRST116') return null;
    throw listingResult.error;
  }

  const listing = listingResult.data;
  const rep     = repResult.data; // may be null if no events yet

  // Determine current blend weights for transparency
  // Agents are reputation-first; services are monitoring-first
  const totalEvents = rep
    ? (rep.tasks_completed + rep.tasks_failed + rep.total_ratings + rep.safety_incident_count)
    : 0;

  let blend = null;
  if (rep?.reputation_score != null) {
    if (listing.listing_type === 'agent') {
      // Agents: reputation dominates from the start
      if (totalEvents < 5)       blend = { technical: 0.40, reputation: 0.60, confidence: 'low' };
      else if (totalEvents < 20) blend = { technical: 0.25, reputation: 0.75, confidence: 'medium' };
      else                       blend = { technical: 0.15, reputation: 0.85, confidence: 'high' };
    } else {
      // Services: monitoring is primary signal, reputation grows with volume
      if (totalEvents < 5)       blend = { technical: 0.80, reputation: 0.20, confidence: 'low' };
      else if (totalEvents < 20) blend = { technical: 0.50, reputation: 0.50, confidence: 'medium' };
      else                       blend = { technical: 0.30, reputation: 0.70, confidence: 'high' };
    }
  }

  return {
    listing_id:   listing.id,
    listing_name: listing.name,
    listing_slug: listing.slug,

    // The single score agents use for filtering/ranking
    trust_score: listing.trust_score,

    // Score breakdown — full transparency for agent decision-making
    breakdown: {
      technical_score: listing.technical_trust_score,
      reputation_score: rep?.reputation_score ?? null,
      blend_weights: blend,
    },

    // Reputation detail
    reputation: rep
      ? {
          total_transactions:   rep.total_transactions,
          tasks_completed:      rep.tasks_completed,
          tasks_failed:         rep.tasks_failed,
          task_completion_rate: rep.task_completion_rate
            ? Number((rep.task_completion_rate * 100).toFixed(1)) + '%'
            : null,
          avg_cost_efficiency:  rep.avg_cost_efficiency,
          safety_incident_count: rep.safety_incident_count,
          avg_user_rating:      rep.avg_user_rating,
          total_ratings:        rep.total_ratings,
          last_calculated_at:   rep.last_calculated_at,
        }
      : null,

    // What each component means — useful for agents reasoning about scores
    _meta: {
      scoring_note: 'trust_score is a blend of technical reliability (uptime, speed, SSL) and behavioral reputation (task outcomes, user ratings). Recent events carry more weight than old ones (30-day half-life).',
      safety_note:  'Each safety_flag incident in the last 90 days applies a hard -15pt penalty to reputation_score, capped at -50.',
      confidence:   blend?.confidence ?? 'none',
      event_count:  totalEvents,
    },
  };
}
