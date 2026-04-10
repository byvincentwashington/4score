#!/usr/bin/env node
// ============================================================
// Scory — Listing Import Script
// Usage: node scripts/import-listings.js [path-to-json-file]
// Default file: scripts/data/seed-listings.json
// ============================================================

import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { VoyageAIClient } from 'voyageai';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Clients ──────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY });

// ── Config ───────────────────────────────────────────────────────────────────

const INPUT_FILE = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(__dirname, 'data/seed-listings.json');

const EMBED_BATCH_SIZE = 20;   // Voyage AI max per request is 128; keep low to be safe
const INSERT_DELAY_MS  = 200;  // Small pause between inserts to avoid Supabase rate limits

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildEmbedText(listing) {
  return [
    listing.name,
    listing.short_description,
    listing.description,
    ...(listing.capabilities || []),
    ...(listing.tags || []),
  ].filter(Boolean).join(' ');
}

function validateListing(listing, index) {
  const required = ['name', 'slug', 'short_description', 'description',
                    'endpoint_url', 'category_slug', 'pricing_type'];
  const missing = required.filter((f) => !listing[f]);
  if (missing.length > 0) {
    return `Listing[${index}] "${listing.name || 'unnamed'}" missing: ${missing.join(', ')}`;
  }
  if (listing.short_description?.length > 280) {
    return `Listing[${index}] "${listing.name}" short_description exceeds 280 chars`;
  }
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🚀 Scory Import Script');
  console.log('━'.repeat(50));
  console.log(`📂 Input file: ${INPUT_FILE}\n`);

  // ── Load JSON ──────────────────────────────────────────────────────────────
  let listings;
  try {
    const raw = readFileSync(INPUT_FILE, 'utf8');
    listings = JSON.parse(raw);
  } catch (err) {
    console.error(`❌ Failed to read ${INPUT_FILE}:`, err.message);
    process.exit(1);
  }

  if (!Array.isArray(listings) || listings.length === 0) {
    console.error('❌ File must contain a non-empty JSON array of listings');
    process.exit(1);
  }

  console.log(`📋 Found ${listings.length} listings to import\n`);

  // ── Validate all listings up front ────────────────────────────────────────
  console.log('🔍 Validating listings...');
  const errors = listings.map(validateListing).filter(Boolean);
  if (errors.length > 0) {
    console.error('❌ Validation errors found — fix these before importing:\n');
    errors.forEach((e) => console.error('  •', e));
    process.exit(1);
  }
  console.log('  ✅ All listings valid\n');

  // ── Pre-fetch category and capability maps ─────────────────────────────────
  console.log('📡 Fetching categories and capabilities from Supabase...');

  const [{ data: categories, error: catErr }, { data: capabilities, error: capErr }] =
    await Promise.all([
      supabase.from('categories').select('id, slug'),
      supabase.from('capabilities').select('id, slug'),
    ]);

  if (catErr) { console.error('❌ Failed to fetch categories:', catErr.message); process.exit(1); }
  if (capErr) { console.error('❌ Failed to fetch capabilities:', capErr.message); process.exit(1); }

  const categoryMap   = Object.fromEntries(categories.map((c) => [c.slug, c.id]));
  const capabilityMap = Object.fromEntries(capabilities.map((c) => [c.slug, c.id]));

  console.log(`  ✅ ${categories.length} categories, ${capabilities.length} capabilities loaded\n`);

  // ── Validate all slugs exist ───────────────────────────────────────────────
  const slugErrors = [];
  for (const [i, listing] of listings.entries()) {
    if (!categoryMap[listing.category_slug]) {
      slugErrors.push(`Listing[${i}] "${listing.name}": unknown category_slug "${listing.category_slug}"`);
    }
    for (const cap of (listing.capabilities || [])) {
      if (!capabilityMap[cap]) {
        slugErrors.push(`Listing[${i}] "${listing.name}": unknown capability "${cap}"`);
      }
    }
  }

  if (slugErrors.length > 0) {
    console.error('❌ Unknown slugs found:\n');
    slugErrors.forEach((e) => console.error('  •', e));
    process.exit(1);
  }

  // ── Generate embeddings in batches ────────────────────────────────────────
  console.log('🧠 Generating embeddings (Voyage AI voyage-3)...');
  const embedTexts  = listings.map(buildEmbedText);
  const embeddings  = [];

  for (let i = 0; i < embedTexts.length; i += EMBED_BATCH_SIZE) {
    const batch      = embedTexts.slice(i, i + EMBED_BATCH_SIZE);
    const batchEnd   = Math.min(i + EMBED_BATCH_SIZE, embedTexts.length);
    process.stdout.write(`  Embedding ${i + 1}–${batchEnd} of ${embedTexts.length}...`);

    const result = await voyage.embed({
      input:     batch,
      model:     'voyage-3',
      inputType: 'document',
    });

    embeddings.push(...result.data.map((d) => d.embedding));
    console.log(' ✅');

    if (batchEnd < embedTexts.length) await sleep(500); // rate limit buffer
  }

  console.log();

  // ── Insert listings ────────────────────────────────────────────────────────
  console.log('💾 Inserting listings into Supabase...\n');

  let inserted = 0;
  let skipped  = 0;
  const failed = [];

  for (const [i, listing] of listings.entries()) {
    const label = `  [${i + 1}/${listings.length}] ${listing.name}`;
    process.stdout.write(label.padEnd(55));

    // Insert the listing row
    const { data: row, error: insertErr } = await supabase
      .from('listings')
      .insert({
        name:                listing.name,
        slug:                listing.slug,
        short_description:   listing.short_description,
        description:         listing.description,
        endpoint_url:        listing.endpoint_url,
        documentation_url:   listing.documentation_url || null,
        website_url:         listing.website_url || null,
        category_id:         categoryMap[listing.category_slug],
        pricing_type:        listing.pricing_type,
        pricing_details:     listing.pricing_details || {},
        auth_type:           listing.auth_type || 'api_key',
        tags:                listing.tags || [],
        languages_supported: listing.languages_supported || ['en'],
        regions_supported:   listing.regions_supported || ['global'],
        response_schema:     listing.response_schema || null,
        submitted_by:        'import-script',
        embedding:           embeddings[i],
      })
      .select('id')
      .single();

    if (insertErr) {
      if (insertErr.code === '23505') {
        // Duplicate slug — skip gracefully
        console.log('⚠️  skipped (slug already exists)');
        skipped++;
      } else {
        console.log('❌ failed');
        failed.push({ name: listing.name, error: insertErr.message });
      }
      continue;
    }

    // Insert capability associations
    const capSlugs = listing.capabilities || [];
    if (capSlugs.length > 0) {
      const joins = capSlugs.map((slug) => ({
        listing_id:    row.id,
        capability_id: capabilityMap[slug],
      }));
      const { error: capErr } = await supabase.from('listing_capabilities').insert(joins);
      if (capErr) {
        console.log('⚠️  inserted (capability link failed)');
        failed.push({ name: listing.name, error: `capability link: ${capErr.message}` });
        inserted++;
        continue;
      }
    }

    console.log('✅');
    inserted++;

    await sleep(INSERT_DELAY_MS);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '━'.repeat(50));
  console.log('📊 Import Summary');
  console.log('━'.repeat(50));
  console.log(`  ✅ Inserted:  ${inserted}`);
  console.log(`  ⚠️  Skipped:   ${skipped} (already exist)`);
  console.log(`  ❌ Failed:    ${failed.length}`);

  if (failed.length > 0) {
    console.log('\nFailed listings:');
    failed.forEach(({ name, error }) => console.log(`  • ${name}: ${error}`));
  }

  console.log('\n✨ Done. Run the server and try a query to see results.\n');
}

main().catch((err) => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
