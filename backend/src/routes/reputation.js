import { Router } from 'express';
import { submitReputationEvent, getReputation } from '../services/reputation.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/v1/reputation/event
 *
 * Submit a reputation event for a listing. Called by agents after
 * interacting with a service. Triggers an async trust score recalculation.
 *
 * Body:
 *   listing_id  {string}  UUID of the listing  [required]
 *   event_type  {string}  task_completed | task_failed | overspend |
 *                         safety_flag | user_rating  [required]
 *   value       {number}  Required for overspend (0–100) and user_rating (1–5)
 *   metadata    {object}  Optional context, e.g.:
 *                           task_completed: { task_id, duration_ms }
 *                           overspend:      { cost_expected_usd, cost_actual_usd }
 *                           safety_flag:    { reason, severity }
 *                           user_rating:    { comment }
 *
 * Response 201:
 *   { ok: true, message: "Event recorded. Trust score updated." }
 *
 * Response 400 / 404 / 429:
 *   { error: "..." }
 */
router.post('/event', async (req, res) => {
  try {
    const { listing_id, event_type, value, metadata } = req.body || {};

    if (!listing_id || !UUID_RE.test(listing_id)) {
      return res.status(400).json({ error: 'listing_id must be a valid UUID' });
    }

    if (!event_type) {
      return res.status(400).json({ error: 'event_type is required' });
    }

    const result = await submitReputationEvent({
      listing_id,
      event_type,
      value,
      metadata,
      reporter_ip: req.ip,
    });

    return res.status(result.status).json(
      result.ok
        ? { ok: true, message: result.message }
        : { error: result.message }
    );

  } catch (err) {
    console.error('[reputation] POST /event error:', err.message);
    return res.status(500).json({ error: 'Failed to record event' });
  }
});

/**
 * GET /api/v1/reputation/:listing_id
 *
 * Returns the current trust score and full breakdown for a listing.
 * Agents can use this to inspect score components before deciding to use a service.
 *
 * Response 200:
 *   {
 *     listing_id, listing_name, listing_slug,
 *     trust_score,            ← the blended score (0–100) used for filtering
 *     breakdown: {
 *       technical_score,      ← from uptime / speed / SSL monitoring
 *       reputation_score,     ← from agent-reported events
 *       blend_weights: { technical, reputation, confidence }
 *     },
 *     reputation: {
 *       total_transactions, tasks_completed, tasks_failed,
 *       task_completion_rate, avg_cost_efficiency,
 *       safety_incident_count, avg_user_rating, total_ratings,
 *       last_calculated_at
 *     },
 *     _meta: { scoring_note, safety_note, confidence, event_count }
 *   }
 */
router.get('/:listing_id', async (req, res) => {
  try {
    const { listing_id } = req.params;

    if (!UUID_RE.test(listing_id)) {
      return res.status(400).json({ error: 'listing_id must be a valid UUID' });
    }

    const data = await getReputation(listing_id);

    if (!data) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    return res.json(data);

  } catch (err) {
    console.error('[reputation] GET error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch reputation' });
  }
});

export default router;
