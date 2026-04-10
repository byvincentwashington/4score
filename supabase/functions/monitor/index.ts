// ─────────────────────────────────────────────────────────────────────────────
// 4score — Monitoring Edge Function
//
// Scheduled hourly via pg_cron. Pings each listing's endpoint, records
// response time / uptime / SSL validity, updates trust scores, and flags
// listings with 5+ consecutive failures for admin review.
//
// Runs in Deno (Supabase Edge Runtime). Uses fetch() instead of axios.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const PING_TIMEOUT_MS = 5000;  // 5s per ping (Edge Function has 60s total budget)
const BATCH_SIZE      = 10;    // listings per run (concurrent — fits in 60s easily)

// ── Entry point ───────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // Only allow calls from Supabase internals (pg_cron) or with the service key.
  // pg_cron passes the CRON_SECRET we set; reject everything else.
  const cronSecret = Deno.env.get('CRON_SECRET');
  const authHeader = req.headers.get('authorization') ?? '';

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const supabaseUrl     = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase        = createClient(supabaseUrl, supabaseKey);

  try {
    const summary = await runMonitoringBatch(supabase);
    return Response.json({ ok: true, ...summary });
  } catch (err) {
    console.error('[4score:monitor] Fatal error:', err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
});

// ── Monitoring batch ──────────────────────────────────────────────────────────

async function runMonitoringBatch(supabase: ReturnType<typeof createClient>) {
  const dueThreshold = new Date(Date.now() - 55 * 60 * 1000).toISOString();

  const { data: listings, error } = await supabase
    .from('listings')
    .select('id, name, endpoint_url, response_schema')
    .eq('is_active', true)
    .or(`last_monitored_at.is.null,last_monitored_at.lt.${dueThreshold}`)
    .order('last_monitored_at', { ascending: true, nullsFirst: true })
    .limit(BATCH_SIZE);

  if (error) throw error;
  if (!listings || listings.length === 0) {
    console.log('[4score:monitor] No listings due for monitoring.');
    return { processed: 0 };
  }

  console.log(`[4score:monitor] Pinging ${listings.length} listings…`);

  // Ping all concurrently
  const pingResults = await Promise.allSettled(listings.map(pingListing));

  let processed = 0;

  for (const outcome of pingResults) {
    if (outcome.status === 'rejected') {
      console.error('[4score:monitor] Unexpected error:', outcome.reason);
      continue;
    }

    const log = outcome.value;

    // Insert monitoring log
    const { error: insertErr } = await supabase
      .from('monitoring_logs')
      .insert(log);

    if (insertErr) {
      console.error('[4score:monitor] Log insert failed:', insertErr.message);
      continue;
    }

    // Recalculate trust score
    const { error: scoreErr } = await supabase.rpc('update_listing_trust_score', {
      p_listing_id: log.listing_id,
    });
    if (scoreErr) {
      console.error('[4score:monitor] Trust score update failed:', scoreErr.message);
    }

    // Check for persistent failure pattern
    if (!log.is_up) {
      await checkAndFlagPersistentFailure(supabase, log.listing_id);
    } else {
      // Service recovered — clear the monitoring review flag
      await supabase
        .from('listings')
        .update({ needs_review: false, review_reason: null })
        .eq('id', log.listing_id)
        .eq('review_reason', 'persistent_monitoring_failure');
    }

    processed++;
  }

  console.log(`[4score:monitor] Batch complete. ${processed} processed.`);
  return { processed };
}

// ── Ping a single listing ─────────────────────────────────────────────────────

async function pingListing(listing: {
  id: string;
  endpoint_url: string;
  response_schema: Record<string, unknown> | null;
}) {
  const startTime = Date.now();
  const result = {
    listing_id:       listing.id,
    is_up:            false,
    response_time_ms: null as number | null,
    http_status_code: null as number | null,
    ssl_valid:        null as boolean | null,
    schema_valid:     null as boolean | null,
    error_message:    null as string | null,
    raw_response:     null as Record<string, unknown> | null,
  };

  try {
    const url = new URL(listing.endpoint_url);
    result.ssl_valid = url.protocol === 'https:';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);

    const response = await fetch(listing.endpoint_url, {
      signal: controller.signal,
      headers: {
        'User-Agent': '4score-Monitor/1.0 (+https://4score.ai/monitor)',
        'Accept':     'application/json',
      },
    });

    clearTimeout(timer);

    result.response_time_ms = Date.now() - startTime;
    result.http_status_code = response.status;
    result.is_up            = response.status >= 200 && response.status < 500;

    // Capture a trimmed snapshot of the response body
    try {
      const text = await response.text();
      const trimmed = text.slice(0, 2000);
      try {
        const parsed = JSON.parse(trimmed);
        result.raw_response = typeof parsed === 'object' ? parsed : { body: trimmed };

        // Validate against response_schema if provided
        if (listing.response_schema && typeof parsed === 'object') {
          result.schema_valid = validateSchema(parsed, listing.response_schema);
        } else {
          result.schema_valid = true;
        }
      } catch {
        result.raw_response = { body: trimmed };
        result.schema_valid = true;
      }
    } catch {
      result.schema_valid = true;
    }

  } catch (err: unknown) {
    result.response_time_ms = Date.now() - startTime;

    if (err instanceof Error) {
      result.error_message = err.name === 'AbortError'
        ? `Timeout after ${PING_TIMEOUT_MS}ms`
        : err.message.slice(0, 500);

      // Flag SSL errors explicitly
      if (err.message.includes('certificate') || err.message.includes('SSL')) {
        result.ssl_valid = false;
      }
    }
  }

  return result;
}

// ── Schema validator ──────────────────────────────────────────────────────────

function validateSchema(
  data: Record<string, unknown>,
  schema: Record<string, unknown>,
): boolean {
  try {
    const required = schema.required as string[] | undefined;
    if (required && Array.isArray(required)) {
      for (const key of required) {
        if (!(key in data)) return false;
      }
    }
    const properties = schema.properties as Record<string, { type?: string }> | undefined;
    if (properties) {
      for (const [key, def] of Object.entries(properties)) {
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

// ── Persistent failure detection ──────────────────────────────────────────────

async function checkAndFlagPersistentFailure(
  supabase: ReturnType<typeof createClient>,
  listing_id: string,
) {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  const { data: recentLogs, error } = await supabase
    .from('monitoring_logs')
    .select('is_up')
    .eq('listing_id', listing_id)
    .gte('checked_at', sixHoursAgo)
    .order('checked_at', { ascending: false })
    .limit(5);

  if (error || !recentLogs || recentLogs.length < 5) return;
  if (!recentLogs.every((l: { is_up: boolean }) => !l.is_up)) return;

  const { data: listing } = await supabase
    .from('listings')
    .select('needs_review, name')
    .eq('id', listing_id)
    .single();

  if (listing && !listing.needs_review) {
    await supabase
      .from('listings')
      .update({ needs_review: true, review_reason: 'persistent_monitoring_failure' })
      .eq('id', listing_id);

    console.log(`[4score:monitor] ⚠️  Flagged for review: "${listing.name}" — 5 consecutive failures`);
  }
}
