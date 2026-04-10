import { Router } from 'express';
import crypto from 'crypto';
import supabase from '../db/supabase.js';
import { searchListings } from '../services/search.js';

const router = Router();

// Allowed pricing_type values — validated to prevent junk DB queries
const VALID_PRICING_TYPES  = new Set(['free', 'freemium', 'paid', 'usage_based', 'contact']);
const VALID_LISTING_TYPES  = new Set(['service', 'agent']);

/**
 * GET /api/v1/query
 *
 * The core agent search endpoint. Accepts structured filters and/or a
 * natural language query string. Returns a ranked list of service summaries.
 *
 * Query parameters:
 *   q              {string}   Natural language query (triggers semantic search)
 *   category       {string}   Category slug
 *   capabilities   {string}   Comma-separated capability slugs (AND logic)
 *   pricing_type   {string}   free | freemium | paid | usage_based | contact
 *   min_trust_score {number}  0–100 (default 0)
 *   verified_only  {boolean}  true | false (default false)
 *   sponsored      {boolean}  true | false (default true — include sponsored)
 *   limit          {number}   1–50 (default 10)
 *   offset         {number}   Pagination offset (default 0)
 *
 * Response:
 *   {
 *     results: [...],
 *     total:   number,
 *     query_id: string,
 *     meta: { semantic_search: boolean, filters_applied: object }
 *   }
 */
router.get('/', async (req, res) => {
  try {
    const {
      q,
      type,
      category,
      capabilities,
      pricing_type,
      min_trust_score,
      verified_only,
      sponsored,
      limit  = '10',
      offset = '0',
    } = req.query;

    // ── Input validation ────────────────────────────────────────────────────

    if (q && typeof q !== 'string') {
      return res.status(400).json({ error: '`q` must be a string' });
    }

    if (pricing_type && !VALID_PRICING_TYPES.has(pricing_type)) {
      return res.status(400).json({
        error: `Invalid pricing_type. Valid values: ${[...VALID_PRICING_TYPES].join(', ')}`,
      });
    }

    if (type && !VALID_LISTING_TYPES.has(type)) {
      return res.status(400).json({
        error: `Invalid type. Valid values: ${[...VALID_LISTING_TYPES].join(', ')}`,
      });
    }

    const parsedLimit  = parseInt(limit);
    const parsedOffset = parseInt(offset);
    if (isNaN(parsedLimit)  || parsedLimit < 1  || parsedLimit > 50) {
      return res.status(400).json({ error: '`limit` must be between 1 and 50' });
    }
    if (isNaN(parsedOffset) || parsedOffset < 0) {
      return res.status(400).json({ error: '`offset` must be >= 0' });
    }

    const parsedMinTrust = min_trust_score !== undefined ? parseFloat(min_trust_score) : 0;
    if (isNaN(parsedMinTrust) || parsedMinTrust < 0 || parsedMinTrust > 100) {
      return res.status(400).json({ error: '`min_trust_score` must be between 0 and 100' });
    }

    // Parse capabilities: comma-separated string → array
    const capabilitiesArray = capabilities
      ? capabilities.split(',').map((c) => c.trim()).filter(Boolean)
      : null;

    const filtersApplied = {
      ...(q              && { q }),
      ...(type           && { type }),
      ...(category       && { category }),
      ...(capabilitiesArray?.length && { capabilities: capabilitiesArray }),
      ...(pricing_type   && { pricing_type }),
      ...(min_trust_score !== undefined && { min_trust_score: parsedMinTrust }),
      ...(verified_only  !== undefined && { verified_only: verified_only === 'true' }),
      ...(sponsored      !== undefined && { sponsored: sponsored !== 'false' }),
    };

    // ── Execute search ───────────────────────────────────────────────────────

    const { results, total } = await searchListings({
      q,
      type,
      category,
      capabilities:    capabilitiesArray,
      pricing_type,
      min_trust_score: parsedMinTrust,
      verified_only:   verified_only === 'true',
      sponsored:       sponsored !== 'false',
      limit:           parsedLimit,
      offset:          parsedOffset,
    });

    // ── Log the query (async, non-blocking) ─────────────────────────────────

    const ipHash = crypto
      .createHash('sha256')
      .update(req.ip || 'unknown')
      .digest('hex');

    // Fire-and-forget — don't let logging failures affect the response
    logQuery({ ipHash, q, filtersApplied, results }).catch((err) =>
      console.error('[query] Failed to log query:', err.message)
    );

    // ── Respond ──────────────────────────────────────────────────────────────

    return res.json({
      results,
      total,
      meta: {
        semantic_search:  Boolean(q),
        filters_applied:  filtersApplied,
        limit:            parsedLimit,
        offset:           parsedOffset,
      },
    });

  } catch (err) {
    console.error('[query] Error:', err.message);
    return res.status(500).json({ error: 'Search failed. Please try again.' });
  }
});

// ── Internal: persist query + impressions ───────────────────────────────────

async function logQuery({ ipHash, q, filtersApplied, results }) {
  const { data: queryLog, error: qErr } = await supabase
    .from('query_logs')
    .insert({
      query_text:      q || null,
      ip_hash:         ipHash,
      result_count:    results.length,
      filters_applied: filtersApplied,
    })
    .select('id')
    .single();

  if (qErr || !queryLog) return;

  if (results.length === 0) return;

  const impressions = results.map((r, i) => ({
    query_log_id:  queryLog.id,
    listing_id:    r.id,
    rank_position: i + 1,
    sponsored:     r.sponsored,
    semantic_score: r._scores?.semantic ?? null,
    final_score:    r._scores?.final    ?? null,
  }));

  await supabase.from('impression_logs').insert(impressions);
}

export default router;
