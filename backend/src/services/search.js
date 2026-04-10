import supabase from '../db/supabase.js';
import { embedText } from './embedding.js';

/**
 * Execute a hybrid search against the listings table.
 *
 * When `q` is provided the query is embedded and semantic similarity
 * contributes 40% of the ranking score (see search_listings SQL function).
 * Without `q`, the ranking falls back to trust + uptime + speed only.
 *
 * @param {object} params
 * @param {string}   [params.q]                  Natural language query
 * @param {string}   [params.type]               'service' | 'agent' (null = both)
 * @param {string}   [params.category]            Category slug filter
 * @param {string[]} [params.capabilities]        Required capability slugs (AND logic)
 * @param {string}   [params.pricing_type]        Pricing type filter
 * @param {number}   [params.min_trust_score=0]   Minimum trust score 0-100
 * @param {boolean}  [params.verified_only=false] Only verified listings
 * @param {boolean}  [params.sponsored=true]      Include sponsored listings
 * @param {number}   [params.limit=10]            Results per page (max 50)
 * @param {number}   [params.offset=0]            Pagination offset
 *
 * @returns {Promise<{ results: object[], total: number }>}
 */
export async function searchListings(params) {
  const {
    q,
    type           = null,
    category       = null,
    capabilities   = null,
    pricing_type   = null,
    min_trust_score = 0,
    verified_only  = false,
    sponsored      = true,
    limit          = 10,
    offset         = 0,
  } = params;

  const safeLimit  = Math.min(Math.max(parseInt(limit)  || 10, 1), 50);
  const safeOffset = Math.max(parseInt(offset) || 0, 0);

  // Generate embedding only when a natural language query is provided
  let embedding = null;
  if (q && q.trim().length > 0) {
    embedding = await embedText(q.trim());
  }

  const { data, error } = await supabase.rpc('search_listings', {
    query_embedding:         embedding,
    category_slug_filter:    category      || null,
    capability_slug_filters: capabilities?.length ? capabilities : null,
    pricing_type_filter:     pricing_type  || null,
    listing_type_filter:     type          || null,
    min_trust_score:         Number(min_trust_score) || 0,
    verified_only:           Boolean(verified_only),
    include_sponsored:       sponsored !== false,
    result_limit:            safeLimit,
    result_offset:           safeOffset,
  });

  if (error) throw error;

  return {
    results: (data || []).map(formatSummary),
    total:   data?.length ?? 0,
  };
}

/**
 * Fetch the full detail record for a single listing by id or slug.
 * @param {string} idOrSlug
 * @returns {Promise<object|null>}
 */
export async function getListingDetail(idOrSlug) {
  // Determine whether the identifier is a UUID or a slug
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  const field  = isUuid ? 'id' : 'slug';

  const { data, error } = await supabase
    .from('listings')
    .select(`
      id, name, slug,
      short_description, description,
      listing_type, model, provider,
      endpoint_url, documentation_url, website_url,
      pricing_type, pricing_details,
      auth_type,
      trust_score, uptime_score, avg_response_time_ms, avg_task_duration_ms,
      error_rate, ssl_valid, schema_compliance_score,
      verification_status, featured, sponsored,
      impression_count, last_monitored_at,
      languages_supported, regions_supported,
      tags, created_at, updated_at,
      categories ( name, slug ),
      listing_capabilities (
        capabilities ( name, slug, description )
      )
    `)
    .eq(field, idOrSlug)
    .eq('is_active', true)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // not found
    throw error;
  }

  return formatDetail(data);
}

// ── Formatters ──────────────────────────────────────────────────────────────

function formatSummary(row) {
  return {
    id:                  row.id,
    name:                row.name,
    slug:                row.slug,
    listing_type:        row.listing_type,
    short_description:   row.short_description,
    category:            { name: row.category_name, slug: row.category_slug },
    capabilities:        row.capabilities || [],
    trust_score:         row.trust_score,
    pricing_type:        row.pricing_type,
    endpoint_url:        row.endpoint_url,
    auth_type:           row.auth_type,
    verification_status: row.verification_status,
    sponsored:           row.sponsored,
    avg_response_time_ms: row.avg_response_time_ms,
    regions_supported:   row.regions_supported,
    // Score breakdown — useful for agent decision-making
    _scores: {
      semantic: row.semantic_score != null ? Number(row.semantic_score.toFixed(4)) : null,
      final:    row.final_score    != null ? Number(row.final_score.toFixed(4))    : null,
    },
    detail_url: `${process.env.API_BASE_URL}/api/v1/listings/${row.id}`,
  };
}

function formatDetail(row) {
  return {
    id:                      row.id,
    name:                    row.name,
    slug:                    row.slug,
    listing_type:            row.listing_type,
    // Agent-specific fields (null for services)
    ...(row.listing_type === 'agent' && {
      model:    row.model,
      provider: row.provider,
    }),
    short_description:       row.short_description,
    description:             row.description,
    endpoint_url:            row.endpoint_url,
    documentation_url:       row.documentation_url,
    website_url:             row.website_url,
    category:                row.categories,
    capabilities:            row.listing_capabilities?.map((lc) => lc.capabilities) || [],
    tags:                    row.tags,
    pricing: {
      type:    row.pricing_type,
      details: row.pricing_details,
    },
    auth_type:               row.auth_type,
    quality: {
      trust_score:              row.trust_score,
      uptime_score:             row.uptime_score,
      avg_response_time_ms:     row.avg_response_time_ms,
      avg_task_duration_ms:     row.avg_task_duration_ms,
      error_rate:               row.error_rate,
      ssl_valid:                row.ssl_valid,
      schema_compliance_score:  row.schema_compliance_score,
      last_monitored_at:        row.last_monitored_at,
    },
    verification_status:     row.verification_status,
    featured:                row.featured,
    sponsored:               row.sponsored,
    impression_count:        row.impression_count,
    languages_supported:     row.languages_supported,
    regions_supported:       row.regions_supported,
    created_at:              row.created_at,
    updated_at:              row.updated_at,
  };
}
