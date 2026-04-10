import axios from 'axios';
import https from 'https';
import cron from 'node-cron';
import supabase from '../db/supabase.js';

const PING_TIMEOUT_MS  = parseInt(process.env.MONITOR_PING_TIMEOUT_MS || '8000');
const CRON_SCHEDULE    = process.env.MONITOR_CRON_SCHEDULE || '0 * * * *'; // default: hourly
const BATCH_SIZE       = 20; // listings pinged per cron run to avoid hammering Railway's CPU

// ── Ping a single listing endpoint ──────────────────────────────────────────

/**
 * Performs a synthetic health check on a listing's endpoint.
 * Checks: reachability, response time, HTTP status, SSL validity, and
 * optionally validates the response body against the listing's response_schema.
 *
 * @param {object} listing  Row from the listings table
 * @returns {Promise<object>}  Monitoring log payload
 */
async function pingListing(listing) {
  const startTime = Date.now();
  const result = {
    listing_id:       listing.id,
    is_up:            false,
    response_time_ms: null,
    http_status_code: null,
    ssl_valid:        null,
    schema_valid:     null,
    error_message:    null,
    raw_response:     null,
  };

  try {
    const url = new URL(listing.endpoint_url);
    result.ssl_valid = url.protocol === 'https:';

    const response = await axios.get(listing.endpoint_url, {
      timeout: PING_TIMEOUT_MS,
      validateStatus: () => true, // don't throw on 4xx/5xx — capture them
      maxRedirects: 3,
      // Use a custom HTTPS agent to detect cert validity
      httpsAgent: new https.Agent({ rejectUnauthorized: true }),
      headers: {
        'User-Agent': '4score-Monitor/1.0 (+https://4score.ai/monitor)',
        Accept: 'application/json',
      },
    });

    result.response_time_ms = Date.now() - startTime;
    result.http_status_code = response.status;
    result.is_up = response.status >= 200 && response.status < 500;

    // Store a trimmed snapshot of the response body for debugging
    if (response.data) {
      const raw = typeof response.data === 'string'
        ? response.data.slice(0, 2000)
        : response.data;
      result.raw_response = typeof raw === 'object' ? raw : { body: raw };
    }

    // Validate against response_schema if the listing provides one
    if (listing.response_schema && response.data && typeof response.data === 'object') {
      result.schema_valid = validateSchema(response.data, listing.response_schema);
    } else {
      // No schema defined — treat as compliant so it doesn't penalise new listings
      result.schema_valid = true;
    }

  } catch (err) {
    result.response_time_ms = Date.now() - startTime;
    result.error_message    = err.message?.slice(0, 500) ?? 'Unknown error';

    // SSL certificate errors — flag explicitly
    if (err.code === 'CERT_HAS_EXPIRED' || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
      result.ssl_valid = false;
    }
  }

  return result;
}

/**
 * Minimal JSON Schema validator (subset: type, required, properties).
 * Avoids pulling in a heavy library for a simple shape check.
 * Returns true if the response plausibly matches the schema.
 *
 * @param {object} data
 * @param {object} schema  JSON Schema object
 * @returns {boolean}
 */
function validateSchema(data, schema) {
  try {
    if (schema.required && Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in data)) return false;
      }
    }
    if (schema.properties) {
      for (const [key, def] of Object.entries(schema.properties)) {
        if (key in data && def.type) {
          const actualType = Array.isArray(data[key]) ? 'array' : typeof data[key];
          if (actualType !== def.type) return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

// ── Monitoring batch ─────────────────────────────────────────────────────────

/**
 * Fetches the next batch of listings due for monitoring and pings them.
 * "Due" means: last_monitored_at is null OR older than 55 minutes
 * (slightly less than the hourly cron to catch any timing drift).
 */
async function runMonitoringBatch() {
  const dueThreshold = new Date(Date.now() - 55 * 60 * 1000).toISOString();

  const { data: listings, error } = await supabase
    .from('listings')
    .select('id, endpoint_url, response_schema')
    .eq('is_active', true)
    .or(`last_monitored_at.is.null,last_monitored_at.lt.${dueThreshold}`)
    .limit(BATCH_SIZE)
    .order('last_monitored_at', { ascending: true, nullsFirst: true });

  if (error) {
    console.error('[monitor] Failed to fetch listings:', error.message);
    return;
  }

  if (!listings || listings.length === 0) {
    console.log('[monitor] No listings due for monitoring.');
    return;
  }

  console.log(`[monitor] Pinging ${listings.length} listings…`);

  // Ping all listings in the batch concurrently
  const pingResults = await Promise.allSettled(listings.map(pingListing));

  for (const outcome of pingResults) {
    if (outcome.status === 'rejected') {
      console.error('[monitor] Unexpected ping error:', outcome.reason);
      continue;
    }

    const log = outcome.value;

    // Insert monitoring log
    const { error: insertErr } = await supabase
      .from('monitoring_logs')
      .insert(log);

    if (insertErr) {
      console.error('[monitor] Failed to insert monitoring log:', insertErr.message);
      continue;
    }

    // Recalculate and persist trust score
    const { error: scoreErr } = await supabase.rpc('update_listing_trust_score', {
      p_listing_id: log.listing_id,
    });

    if (scoreErr) {
      console.error('[monitor] Failed to update trust score:', scoreErr.message);
    }

    // Check for persistent failure — flag for review instead of just tanking the score.
    // Threshold: 5 consecutive failures in the last 6 hours.
    // This distinguishes "Stripe is down right now" from "our URL is wrong".
    if (!log.is_up) {
      await checkAndFlagPersistentFailure(log.listing_id);
    } else {
      // Service is back up — clear the review flag if it was set by monitoring
      await supabase
        .from('listings')
        .update({ needs_review: false, review_reason: null })
        .eq('id', log.listing_id)
        .eq('review_reason', 'persistent_monitoring_failure');
    }
  }

  console.log(`[monitor] Batch complete. ${pingResults.filter(r => r.status === 'fulfilled').length} processed.`);
}

// ── Persistent failure detection ─────────────────────────────────────────────

/**
 * If a listing has failed 5+ consecutive checks in the last 6 hours,
 * flag it needs_review = true with reason 'persistent_monitoring_failure'.
 *
 * This surfaces it for admin inspection without silently demoting a real
 * service just because our listed URL might be stale.
 */
async function checkAndFlagPersistentFailure(listing_id) {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  const { data: recentLogs, error } = await supabase
    .from('monitoring_logs')
    .select('is_up')
    .eq('listing_id', listing_id)
    .gte('checked_at', sixHoursAgo)
    .order('checked_at', { ascending: false })
    .limit(5);

  if (error || !recentLogs || recentLogs.length < 5) return;

  const allFailed = recentLogs.every((l) => !l.is_up);
  if (!allFailed) return;

  // 5 consecutive failures — flag for review (only if not already flagged)
  const { data: listing } = await supabase
    .from('listings')
    .select('needs_review, name')
    .eq('id', listing_id)
    .single();

  if (listing && !listing.needs_review) {
    await supabase
      .from('listings')
      .update({
        needs_review:  true,
        review_reason: 'persistent_monitoring_failure',
      })
      .eq('id', listing_id);

    console.log(`[4score:monitor] ⚠️  Flagged for review: "${listing.name}" — 5 consecutive failures`);
  }
}

// ── Cleanup old raw_response data ────────────────────────────────────────────

/**
 * Scrub raw_response from monitoring logs older than 30 days.
 * Raw responses are only for short-term debugging; no need to store long-term.
 */
async function scrubOldMonitoringData() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('monitoring_logs')
    .update({ raw_response: null })
    .lt('checked_at', thirtyDaysAgo)
    .not('raw_response', 'is', null);

  if (error) {
    console.error('[monitor] Scrub failed:', error.message);
  }
}

// ── Start cron ───────────────────────────────────────────────────────────────

export function startMonitoring() {
  if (!cron.validate(CRON_SCHEDULE)) {
    console.error(`[monitor] Invalid cron schedule: "${CRON_SCHEDULE}" — monitoring disabled.`);
    return;
  }

  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      await runMonitoringBatch();
    } catch (err) {
      console.error('[monitor] Cron job error:', err.message);
    }
  });

  // Scrub old data once a day at 03:00
  cron.schedule('0 3 * * *', async () => {
    try {
      await scrubOldMonitoringData();
    } catch (err) {
      console.error('[monitor] Scrub cron error:', err.message);
    }
  });

  console.log(`[4score:monitor] Started. Schedule: "${CRON_SCHEDULE}"`);
}
