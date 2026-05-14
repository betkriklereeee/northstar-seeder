# northstar-seeder

CLI tools for seeding a Supabase `listings` table with sober living homes sourced from the Google Places API (New).

## Prerequisites

- Node.js ≥ 18 (uses native `fetch` and ESM)
- A Google Cloud project with the **Places API (New)** enabled
- A Supabase project with a `listings` table

## Setup

```bash
npm install
cp .env.example .env
# fill in the three keys in .env
```

### Environment variables

| Variable | Description |
|---|---|
| `GOOGLE_PLACES_API_KEY` | Google Places API (New) key |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key (bypasses RLS) |

## Step 1 — Seed from Google Places

```bash
GOOGLE_PLACES_API_KEY=your_key node scripts/seed-google-places.mjs
```

The script searches across 20 Southern California cities by default. After every 10 results it prints a summary table and prompts:

```
Continue? (y/n/s to skip this batch)
  y → save batch and continue
  n → save batch and exit gracefully
  s → discard batch and move to next location
```

Output is written to `scripts/output/google-sober-listings.json`.

### Options

| Flag | Description |
|---|---|
| `--dry-run` | Log results to console, skip writing the output file |
| `--locations "City ST:lat:lng,…"` | Override the default location list |

```bash
# Custom locations
GOOGLE_PLACES_API_KEY=your_key node scripts/seed-google-places.mjs \
  --locations "Miami FL:25.77:-80.19,Tampa FL:27.94:-82.45"

# Dry run (no file written)
GOOGLE_PLACES_API_KEY=your_key node scripts/seed-google-places.mjs --dry-run
```

### Output schema

Each record in `google-sober-listings.json`:

```json
{
  "name": "Serenity House",
  "slug": "serenity-house",
  "status": "draft",
  "address": "123 Main St, Los Angeles, CA 90012",
  "city": "Los Angeles",
  "state": "CA",
  "zip": "90012",
  "latitude": 34.05,
  "longitude": -118.24,
  "phone": "+1 213-555-0100",
  "website": "https://example.com",
  "photo_refs": ["places/abc123/photos/xyz"],
  "rating": 4.5,
  "review_count": 42,
  "operator_id": null,
  "_source": "google_places",
  "_google_place_id": "ChIJ...",
  "_imported_at": "2026-05-14T00:00:00.000Z"
}
```

> `photo_refs` stores raw Google photo resource names only. Photos are not fetched during seeding.

## Step 2 — Import into Supabase

```bash
SUPABASE_URL=https://xxx.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=your_key \
node scripts/import-to-supabase.mjs
```

### Upsert behaviour

| Scenario | Action |
|---|---|
| Place ID not in DB | Insert |
| Place ID exists, `status = draft` | Upsert (overwrite) |
| Place ID exists, `status ≠ draft` | Skip (preserve edits) |

Records with a non-draft status (e.g. `published`, `archived`) are never overwritten, so re-running the import is safe.

## Supabase table

The `listings` table must have a `_google_place_id` column with a unique constraint for upserts to work:

```sql
alter table listings
  add column if not exists _google_place_id text unique;
```

## Default locations

20 cities across Los Angeles and Orange County, CA. Override with `--locations` to seed any US market.
