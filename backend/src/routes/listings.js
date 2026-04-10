import { Router } from 'express';
import supabase from '../db/supabase.js';
import { getListingDetail } from '../services/search.js';
import { embedDocument, buildListingEmbedText } from '../services/embedding.js';

const router = Router();

/**
 * GET /api/v1/listings/:idOrSlug
 *
 * Returns the full detail record for a single listing.
 * Accepts either a UUID or a slug.
 */
router.get('/:idOrSlug', async (req, res) => {
  try {
    const { idOrSlug } = req.params;

    if (!idOrSlug || idOrSlug.length > 200) {
      return res.status(400).json({ error: 'Invalid listing identifier' });
    }

    const listing = await getListingDetail(idOrSlug);

    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    return res.json(listing);
  } catch (err) {
    console.error('[listings] GET error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch listing' });
  }
});

/**
 * GET /api/v1/listings
 *
 * Returns all categories and capabilities — used by agents to understand
 * the available filter vocabulary before querying.
 */
router.get('/', async (req, res) => {
  try {
    const [{ data: categories, error: catErr }, { data: capabilities, error: capErr }] =
      await Promise.all([
        supabase.from('categories').select('name, slug, description, icon').order('name'),
        supabase.from('capabilities').select('name, slug, description').order('name'),
      ]);

    if (catErr) throw catErr;
    if (capErr) throw capErr;

    return res.json({ categories, capabilities });
  } catch (err) {
    console.error('[listings] GET / error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch directory metadata' });
  }
});

/**
 * POST /api/v1/listings
 *
 * Admin-only endpoint to submit a new listing and generate its embedding.
 * Protected by a static admin secret in the Authorization header.
 * (Replace with proper admin auth before going to production.)
 *
 * Body: {
 *   name, slug, short_description, description,
 *   endpoint_url, documentation_url?, website_url?,
 *   category_slug,
 *   capabilities: string[],    -- capability slugs
 *   pricing_type, pricing_details?,
 *   auth_type?,
 *   tags?: string[],
 *   languages_supported?: string[],
 *   regions_supported?: string[],
 *   response_schema?: object,
 *   submitted_by?: string
 * }
 */
router.post('/', requireAdminKey, async (req, res) => {
  try {
    const {
      name, slug, short_description, description,
      listing_type = 'service',
      model, provider,
      endpoint_url, documentation_url, website_url,
      category_slug,
      capabilities = [],
      pricing_type, pricing_details,
      auth_type = 'api_key',
      tags = [],
      languages_supported = ['en'],
      regions_supported   = ['global'],
      response_schema,
      submitted_by,
    } = req.body;

    // ── Required field validation ────────────────────────────────────────────
    if (!['service', 'agent'].includes(listing_type)) {
      return res.status(400).json({ error: 'listing_type must be "service" or "agent"' });
    }

    const missing = ['name', 'slug', 'short_description', 'description',
                     'endpoint_url', 'category_slug', 'pricing_type']
      .filter((f) => !req.body[f]);

    if (missing.length > 0) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    // ── Resolve category_id ──────────────────────────────────────────────────
    const { data: category, error: catErr } = await supabase
      .from('categories')
      .select('id')
      .eq('slug', category_slug)
      .single();

    if (catErr || !category) {
      return res.status(400).json({ error: `Unknown category slug: ${category_slug}` });
    }

    // ── Resolve capability IDs ───────────────────────────────────────────────
    let capabilityRows = [];
    if (capabilities.length > 0) {
      const { data: caps, error: capErr } = await supabase
        .from('capabilities')
        .select('id, slug')
        .in('slug', capabilities);

      if (capErr) throw capErr;

      const unknownCaps = capabilities.filter(
        (s) => !caps.find((c) => c.slug === s)
      );
      if (unknownCaps.length > 0) {
        return res.status(400).json({ error: `Unknown capability slugs: ${unknownCaps.join(', ')}` });
      }
      capabilityRows = caps;
    }

    // ── Generate embedding ───────────────────────────────────────────────────
    const embedText = buildListingEmbedText({
      name, short_description, description, capabilities, tags,
    });
    const embedding = await embedDocument(embedText);

    // ── Insert listing ───────────────────────────────────────────────────────
    const { data: listing, error: insertErr } = await supabase
      .from('listings')
      .insert({
        name, slug, short_description, description,
        listing_type,
        model:    model    || null,
        provider: provider || null,
        endpoint_url, documentation_url, website_url,
        category_id: category.id,
        pricing_type,
        pricing_details: pricing_details || {},
        auth_type,
        tags,
        languages_supported,
        regions_supported,
        response_schema: response_schema || null,
        embedding,
        submitted_by: submitted_by || null,
      })
      .select('id, slug')
      .single();

    if (insertErr) {
      if (insertErr.code === '23505') {
        return res.status(409).json({ error: `A listing with slug "${slug}" already exists` });
      }
      throw insertErr;
    }

    // ── Insert capability associations ───────────────────────────────────────
    if (capabilityRows.length > 0) {
      const joins = capabilityRows.map((c) => ({
        listing_id:    listing.id,
        capability_id: c.id,
      }));
      const { error: joinErr } = await supabase.from('listing_capabilities').insert(joins);
      if (joinErr) throw joinErr;
    }

    return res.status(201).json({
      id:   listing.id,
      slug: listing.slug,
      message: 'Listing created successfully.',
    });

  } catch (err) {
    console.error('[listings] POST error:', err.message);
    return res.status(500).json({ error: 'Failed to create listing' });
  }
});

// ── PATCH /api/v1/listings/:id ────────────────────────────────────────────────
/**
 * Admin-only. Update any fields on an existing listing.
 * Automatically regenerates the embedding if name, short_description,
 * description, capabilities, or tags are changed.
 * Also clears needs_review / review_reason if the listing was flagged.
 *
 * Body: any subset of listing fields. Only provided fields are updated.
 * Special field: capabilities (string[]) — fully replaces capability associations.
 */
router.patch('/:id', requireAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: 'Invalid listing id' });
    }

    // ── Fetch current listing ────────────────────────────────────────────────
    const { data: current, error: fetchErr } = await supabase
      .from('listings')
      .select('id, name, slug, short_description, description, tags, needs_review')
      .eq('id', id)
      .single();

    if (fetchErr || !current) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const {
      capabilities,       // string[] — if present, fully replaces capability links
      category_slug,      // if present, look up new category_id
      ...scalarFields     // all other fields passed through directly
    } = req.body;

    const updates = { ...scalarFields };

    // ── Resolve category if changing ─────────────────────────────────────────
    if (category_slug) {
      const { data: cat, error: catErr } = await supabase
        .from('categories').select('id').eq('slug', category_slug).single();
      if (catErr || !cat) {
        return res.status(400).json({ error: `Unknown category slug: ${category_slug}` });
      }
      updates.category_id = cat.id;
    }

    // ── Regenerate embedding if semantic fields changed ───────────────────────
    const semanticFields = ['name', 'short_description', 'description', 'tags'];
    const semanticChanged = semanticFields.some((f) => f in updates) || capabilities !== undefined;

    if (semanticChanged) {
      // Resolve new capability slugs for embed text
      let capSlugs = capabilities;
      if (!capSlugs) {
        const { data: existingCaps } = await supabase
          .from('listing_capabilities')
          .select('capabilities(slug)')
          .eq('listing_id', id);
        capSlugs = existingCaps?.map((c) => c.capabilities.slug) || [];
      }

      const embedText = buildListingEmbedText({
        name:              updates.name              ?? current.name,
        short_description: updates.short_description ?? current.short_description,
        description:       updates.description       ?? current.description,
        capabilities:      capSlugs,
        tags:              updates.tags              ?? current.tags,
      });
      updates.embedding = await embedDocument(embedText);
    }

    // ── Clear review flag if this is an intentional update ───────────────────
    if (current.needs_review) {
      updates.needs_review  = false;
      updates.review_reason = null;
    }

    // ── Update the listing row ────────────────────────────────────────────────
    const { error: updateErr } = await supabase
      .from('listings')
      .update(updates)
      .eq('id', id);

    if (updateErr) throw updateErr;

    // ── Replace capability associations if provided ──────────────────────────
    if (capabilities !== undefined) {
      const { data: caps, error: capErr } = await supabase
        .from('capabilities').select('id, slug').in('slug', capabilities);
      if (capErr) throw capErr;

      const unknown = capabilities.filter((s) => !caps.find((c) => c.slug === s));
      if (unknown.length > 0) {
        return res.status(400).json({ error: `Unknown capability slugs: ${unknown.join(', ')}` });
      }

      // Delete old links, insert new ones
      await supabase.from('listing_capabilities').delete().eq('listing_id', id);
      if (caps.length > 0) {
        await supabase.from('listing_capabilities').insert(
          caps.map((c) => ({ listing_id: id, capability_id: c.id }))
        );
      }
    }

    // ── Mark any open reports as resolved ────────────────────────────────────
    await supabase
      .from('listing_reports')
      .update({ resolved: true, resolved_at: new Date().toISOString() })
      .eq('listing_id', id)
      .eq('resolved', false);

    return res.json({
      id,
      message:          'Listing updated successfully.',
      embedding_updated: semanticChanged,
      review_cleared:    current.needs_review ?? false,
    });

  } catch (err) {
    console.error('[listings] PATCH error:', err.message);
    return res.status(500).json({ error: 'Failed to update listing' });
  }
});

// ── POST /api/v1/listings/:id/report ─────────────────────────────────────────
/**
 * Public. Agents or users flag a listing as potentially stale or inaccurate.
 * Rate limited: one report per reason per listing per IP per 24 hours.
 * Automatically sets needs_review = true on the listing.
 *
 * Body: {
 *   reason:  'wrong_endpoint' | 'stale_pricing' | 'service_shutdown' |
 *            'inaccurate_info' | 'other'
 *   details?: string  (max 500 chars, optional)
 * }
 */
router.post('/:id/report', async (req, res) => {
  try {
    const { id } = req.params;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: 'Invalid listing id' });
    }

    const VALID_REASONS = new Set([
      'wrong_endpoint', 'stale_pricing', 'service_shutdown', 'inaccurate_info', 'other',
    ]);

    const { reason, details } = req.body || {};

    if (!reason || !VALID_REASONS.has(reason)) {
      return res.status(400).json({
        error: `reason is required. Valid values: ${[...VALID_REASONS].join(', ')}`,
      });
    }

    if (details && details.length > 500) {
      return res.status(400).json({ error: 'details must be 500 characters or fewer' });
    }

    // ── Confirm listing exists ───────────────────────────────────────────────
    const { data: listing, error: listingErr } = await supabase
      .from('listings').select('id').eq('id', id).eq('is_active', true).single();

    if (listingErr || !listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    // ── Rate limit: one report per reason per IP per 24h ─────────────────────
    const { createHash } = await import('crypto');
    const ipHash = createHash('sha256').update(req.ip || 'unknown').digest('hex');
    const since  = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { count } = await supabase
      .from('listing_reports')
      .select('id', { count: 'exact', head: true })
      .eq('listing_id', id)
      .eq('reporter_ip_hash', ipHash)
      .eq('reason', reason)
      .gte('created_at', since);

    if (count > 0) {
      return res.status(429).json({
        error: 'You have already submitted this report type for this listing in the last 24 hours.',
      });
    }

    // ── Insert report ────────────────────────────────────────────────────────
    const { error: insertErr } = await supabase.from('listing_reports').insert({
      listing_id:       id,
      reporter_ip_hash: ipHash,
      reason,
      details:          details || null,
    });
    if (insertErr) throw insertErr;

    // ── Flag listing for review ──────────────────────────────────────────────
    await supabase
      .from('listings')
      .update({ needs_review: true, review_reason: `reported:${reason}` })
      .eq('id', id)
      .eq('needs_review', false); // only set if not already flagged

    return res.status(201).json({
      ok:      true,
      message: 'Report submitted. This listing has been flagged for admin review.',
    });

  } catch (err) {
    console.error('[listings] POST report error:', err.message);
    return res.status(500).json({ error: 'Failed to submit report' });
  }
});

// ── Admin key middleware ─────────────────────────────────────────────────────

function requireAdminKey(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    return res.status(503).json({ error: 'Admin submissions are not configured' });
  }
  const provided = req.headers['authorization']?.replace('Bearer ', '');
  if (provided !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

export default router;
