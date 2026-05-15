/**
 * Searches Google Places API (New) for sober living listings and writes
 * transformed results to scripts/output/google-sober-listings.json.
 *
 * Usage:
 *   GOOGLE_PLACES_API_KEY=xxx node scripts/seed-google-places.mjs
 *   GOOGLE_PLACES_API_KEY=xxx node scripts/seed-google-places.mjs --dry-run
 *   GOOGLE_PLACES_API_KEY=xxx node scripts/seed-google-places.mjs \
 *     --locations "Miami FL:25.77:-80.19,Tampa FL:27.94:-82.45"
 */

import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'google-sober-listings.json');

const PLACES_API_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.location',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
  'places.photos',
  'places.businessStatus',
  'places.editorialSummary',
  'places.googleMapsUri',
].join(',');

const BATCH_SIZE = 10;
const REQUEST_DELAY_MS = 500;

const DEFAULT_LOCATIONS = [
  { name: 'Los Angeles',     state: 'CA', lat: 34.05, lng: -118.24 },
  { name: 'Pasadena',        state: 'CA', lat: 34.14, lng: -118.14 },
  { name: 'Long Beach',      state: 'CA', lat: 33.76, lng: -118.18 },
  { name: 'Burbank',         state: 'CA', lat: 34.18, lng: -118.30 },
  { name: 'Santa Monica',    state: 'CA', lat: 34.01, lng: -118.49 },
  { name: 'West Hollywood',  state: 'CA', lat: 34.09, lng: -118.36 },
  { name: 'Culver City',     state: 'CA', lat: 34.02, lng: -118.39 },
  { name: 'Inglewood',       state: 'CA', lat: 33.96, lng: -118.35 },
  { name: 'Torrance',        state: 'CA', lat: 33.83, lng: -118.34 },
  { name: 'Compton',         state: 'CA', lat: 33.89, lng: -118.22 },
  { name: 'Anaheim',         state: 'CA', lat: 33.83, lng: -117.91 },
  { name: 'Santa Ana',       state: 'CA', lat: 33.74, lng: -117.86 },
  { name: 'Irvine',          state: 'CA', lat: 33.68, lng: -117.82 },
  { name: 'Huntington Beach',state: 'CA', lat: 33.66, lng: -118.00 },
  { name: 'Costa Mesa',      state: 'CA', lat: 33.64, lng: -117.91 },
  { name: 'Newport Beach',   state: 'CA', lat: 33.61, lng: -117.92 },
  { name: 'Garden Grove',    state: 'CA', lat: 33.77, lng: -117.94 },
  { name: 'Fullerton',       state: 'CA', lat: 33.87, lng: -117.92 },
  { name: 'Orange',          state: 'CA', lat: 33.78, lng: -117.85 },
  { name: 'Mission Viejo',   state: 'CA', lat: 33.59, lng: -117.65 },
];

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { locations: null, dryRun: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') {
      result.dryRun = true;
    } else if (args[i] === '--locations' && args[i + 1]) {
      // Format per location: "City State:lat:lng"
      // e.g. "Miami FL:25.77:-80.19,Tampa FL:27.94:-82.45"
      result.locations = args[i + 1].split(',').map(raw => {
        const parts = raw.trim().split(':');
        const lng = parseFloat(parts.pop());
        const lat = parseFloat(parts.pop());
        const cityState = parts.join(':').trim();
        const tokens = cityState.split(' ');
        const state = tokens.pop();
        const name = tokens.join(' ');
        return { name, state, lat, lng };
      });
      i++;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

function toSlug(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function generateSlug(name, usedSlugs) {
  const base = toSlug(name);
  if (!usedSlugs.has(base)) {
    usedSlugs.add(base);
    return base;
  }
  let n = 2;
  while (usedSlugs.has(`${base}-${n}`)) n++;
  const slug = `${base}-${n}`;
  usedSlugs.add(slug);
  return slug;
}

// ---------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------

function extractAddressComponents(components) {
  const result = { city: '', state: '', zip: '', county: null };
  if (!Array.isArray(components)) return result;

  for (const comp of components) {
    const types = comp.types ?? [];
    if (types.includes('locality')) {
      result.city = comp.longText ?? comp.shortText ?? '';
    } else if (types.includes('administrative_area_level_1')) {
      result.state = comp.shortText ?? comp.longText ?? '';
    } else if (types.includes('administrative_area_level_2')) {
      result.county = comp.longText ?? null;
    } else if (types.includes('postal_code')) {
      result.zip = comp.longText ?? comp.shortText ?? '';
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

function transformPlace(place, usedSlugs) {
  const { city, state, zip, county } = extractAddressComponents(place.addressComponents);
  const name = place.displayName?.text ?? '';

  return {
    name,
    slug: generateSlug(name, usedSlugs),
    status: 'pending',
    address: place.formattedAddress ?? '',
    city,
    state,
    zip,
    county,
    lat:  place.location?.latitude  ?? null,
    lng: place.location?.longitude ?? null,
    phone:   place.nationalPhoneNumber ?? '',
    website: place.websiteUri ?? '',
    description: place.editorialSummary?.text ?? null,
    maps_url: place.googleMapsUri ?? null,
    photos: (place.photos ?? []).map(p => p.name),
    rating:       place.rating          ?? null,
    review_count: place.userRatingCount ?? null,
    verified: false,
    operator_id: null,
    source: 'google_places',
    _google_place_id: place.id ?? '',
    _imported_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// API fetch
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function* fetchPlacesForLocation(apiKey, location) {
  let pageToken = null;
  let page = 1;

  do {
    const body = {
      textQuery: `sober living home ${location.name} ${location.state}`,
      locationBias: {
        circle: {
          center: { latitude: location.lat, longitude: location.lng },
          radius: 50000,
        },
      },
      maxResultCount: 20,
    };
    if (pageToken) body.pageToken = pageToken;

    const res = await fetch(PLACES_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`  [ERROR] ${location.name} ${location.state} page ${page}: HTTP ${res.status} ${errText}`);
      return;
    }

    const data = await res.json();
    const places = data.places ?? [];

    console.log(`  ${location.name} ${location.state} — page ${page}: ${places.length} result(s)`);

    yield { places, page };

    pageToken = data.nextPageToken ?? null;
    page++;

    if (pageToken) await sleep(REQUEST_DELAY_MS);
  } while (pageToken);
}

// ---------------------------------------------------------------------------
// Interactive batch UI
// ---------------------------------------------------------------------------

function printBatchTable(batch, startIndex) {
  const COL = { idx: 5, name: 36, city: 20, phone: 18, website: 45 };
  const LINE = '─'.repeat(COL.idx + COL.name + COL.city + COL.phone + COL.website);

  console.log('\n' + LINE);
  console.log(
    '#'.padEnd(COL.idx) +
    'Name'.padEnd(COL.name) +
    'City'.padEnd(COL.city) +
    'Phone'.padEnd(COL.phone) +
    'Website',
  );
  console.log(LINE);

  batch.forEach((item, i) => {
    const idx    = String(startIndex + i + 1).padEnd(COL.idx);
    const name   = (item.name   ?? '').slice(0, COL.name   - 2).padEnd(COL.name);
    const city   = (item.city   ?? '').slice(0, COL.city   - 2).padEnd(COL.city);
    const phone  = (item.phone  ?? '').slice(0, COL.phone  - 2).padEnd(COL.phone);
    const website = (item.website ?? '').slice(0, COL.website - 1);
    console.log(idx + name + city + phone + website);
  });

  console.log(LINE + '\n');
}

function askQuestion(rl, question) {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim().toLowerCase())));
}

async function promptBatch(rl, batch, allListings, seenPlaceIds, startIndex) {
  printBatchTable(batch, startIndex);

  const answer = await askQuestion(
    rl,
    `Fetched ${allListings.length + batch.length} total so far, ${seenPlaceIds.size} unique after dedup\n` +
    `Continue? (y/n/s to skip this batch): `,
  );

  return answer === 'n' ? 'exit'
       : answer === 's' ? 'skip'
       : 'continue';
}

// ---------------------------------------------------------------------------
// Per-location processor
// ---------------------------------------------------------------------------

async function processLocation(apiKey, location, seenPlaceIds, usedSlugs, allListings, rl) {
  console.log(`\nSearching: ${location.name} ${location.state}`);

  let pending = [];
  let skipLocation = false;
  let exitAll = false;
  let batchStart = allListings.length;

  for await (const { places } of fetchPlacesForLocation(apiKey, location)) {
    for (const place of places) {
      if (place.businessStatus === 'CLOSED_PERMANENTLY') continue;
      if (seenPlaceIds.has(place.id)) continue;
      seenPlaceIds.add(place.id);
      pending.push(transformPlace(place, usedSlugs));
    }

    while (pending.length >= BATCH_SIZE) {
      const batch = pending.splice(0, BATCH_SIZE);
      const action = await promptBatch(rl, batch, allListings, seenPlaceIds, batchStart);

      if (action === 'continue') {
        allListings.push(...batch);
        batchStart += batch.length;
      } else if (action === 'exit') {
        allListings.push(...batch);
        batchStart += batch.length;
        exitAll = true;
        break;
      } else {
        // 'skip' — discard batch and stop fetching this location
        skipLocation = true;
        break;
      }
    }

    if (skipLocation || exitAll) break;
  }

  // Flush remaining results (partial last batch for this location)
  if (!skipLocation && !exitAll && pending.length > 0) {
    const action = await promptBatch(rl, pending, allListings, seenPlaceIds, batchStart);
    if (action === 'continue') {
      allListings.push(...pending);
    } else if (action === 'exit') {
      allListings.push(...pending);
      exitAll = true;
    }
    // 'skip' → discard silently
  }

  return exitAll;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.error('Error: GOOGLE_PLACES_API_KEY environment variable is not set.');
    process.exit(1);
  }

  const { locations, dryRun } = parseArgs();
  const locationList = locations ?? DEFAULT_LOCATIONS;

  if (dryRun) console.log('[dry-run] Results will not be written to disk.\n');

  console.log(`Starting search across ${locationList.length} location(s)…\n`);

  const seenPlaceIds = new Set();
  const usedSlugs    = new Set();
  const allListings  = [];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Ensure readline is closed on exit so the process can terminate cleanly
  process.on('SIGINT', () => {
    rl.close();
    process.exit(0);
  });

  for (const location of locationList) {
    const done = await processLocation(apiKey, location, seenPlaceIds, usedSlugs, allListings, rl);
    if (done) break;
  }

  rl.close();

  console.log(`\n━━━ Done ━━━`);
  console.log(`Total listings collected : ${allListings.length}`);
  console.log(`Unique place IDs seen    : ${seenPlaceIds.size}`);

  if (dryRun) {
    console.log('\n[dry-run] Skipping file write.');
    return;
  }

  if (allListings.length === 0) {
    console.log('Nothing to write.');
    return;
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(allListings, null, 2));
  console.log(`\nWritten → ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
