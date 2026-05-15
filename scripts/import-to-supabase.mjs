/**
 * Reads scripts/output/google-sober-listings.json and upserts records into
 * the Supabase `listings` table.
 *
 * Upsert rules:
 *   - New records (not in DB)             → insert
 *   - Existing records with status=draft  → upsert (overwrite)
 *   - Existing records with other status  → skip (preserve human edits)
 *
 * Usage:
 *   SUPABASE_URL=xxx SUPABASE_SERVICE_ROLE_KEY=xxx node scripts/import-to-supabase.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT_FILE = path.join(__dirname, 'output', 'google-sober-listings.json');

const UPSERT_CHUNK_SIZE = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`Error: ${name} environment variable is not set.`);
    process.exit(1);
  }
  return val;
}

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const supabaseUrl    = requireEnv('SUPABASE_URL');
  const supabaseKey    = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });

  // Load input file
  let listings;
  try {
    const raw = await fs.readFile(INPUT_FILE, 'utf8');
    listings = JSON.parse(raw);
  } catch (err) {
    console.error(`Could not read ${INPUT_FILE}: ${err.message}`);
    console.error('Run seed-google-places.mjs first to generate the input file.');
    process.exit(1);
  }

  if (!Array.isArray(listings) || listings.length === 0) {
    console.log('Input file is empty — nothing to import.');
    return;
  }

  console.log(`Loaded ${listings.length} listing(s) from ${INPUT_FILE}`);

  // Collect all _google_place_ids from the input
  const inputIds = listings.map(l => l._google_place_id).filter(Boolean);

  // Fetch existing rows for those IDs to determine skip/upsert behaviour
  const { data: existingRows, error: fetchErr } = await supabase
    .from('listings')
    .select('_google_place_id, status')
    .in('_google_place_id', inputIds);

  if (fetchErr) {
    console.error('Error fetching existing records:', fetchErr.message);
    process.exit(1);
  }

  // Build lookup: place_id → existing status
  const existingStatus = new Map(
    (existingRows ?? []).map(r => [r._google_place_id, r.status]),
  );

  const toUpsert = [];
  const skipped  = [];

  for (const listing of listings) {
    const id = listing._google_place_id;
    if (!id) continue;

    const currentStatus = existingStatus.get(id);

    if (currentStatus !== undefined && currentStatus !== 'pending') {
      // Record exists and has been promoted — preserve it
      skipped.push({ id, status: currentStatus });
      continue;
    }

    toUpsert.push(listing);
  }

  console.log(`\nPlan:`);
  console.log(`  To upsert : ${toUpsert.length}`);
  console.log(`  Skipped   : ${skipped.length} (non-draft status)`);

  if (toUpsert.length === 0) {
    console.log('\nNothing to upsert.');
    return;
  }

  // Upsert in chunks to stay within Supabase payload limits
  let insertedCount = 0;
  let errorCount    = 0;

  for (const batch of chunk(toUpsert, UPSERT_CHUNK_SIZE)) {
    const { error } = await supabase
      .from('listings')
      .upsert(batch, { onConflict: '_google_place_id' });

    if (error) {
      console.error(`Upsert error (batch of ${batch.length}):`, error.message);
      errorCount += batch.length;
    } else {
      insertedCount += batch.length;
      process.stdout.write(`  Upserted ${insertedCount}/${toUpsert.length}…\r`);
    }
  }

  console.log('\n');
  console.log('━━━ Import complete ━━━');
  console.log(`  Upserted : ${insertedCount}`);
  console.log(`  Skipped  : ${skipped.length}`);
  console.log(`  Errors   : ${errorCount}`);

  if (skipped.length > 0) {
    console.log('\nSkipped place IDs (status preserved):');
    for (const { id, status } of skipped) {
      console.log(`  ${id}  [${status}]`);
    }
  }

  if (errorCount > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
