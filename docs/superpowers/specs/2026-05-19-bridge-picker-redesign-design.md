# Bridge Picker Redesign + Multi-Season Backfill — Design Spec

**Status:** Draft → pending implementation
**Date:** 2026-05-19
**Author:** Ricardo + Claude (collaborative)

## Goal

Rework the bridge app's Picker tab from a dropdown cascade into a cards-everywhere navigation flow (Season → Week → Track → Track-Detail-by-Class), and backfill the last 4 iRacing seasons so the season selector has meaningful options.

Today's Picker forces a Week → Track → Car dropdown chain that shows only one car at a time. The redesign mirrors the website's hierarchical navigation and adds per-class-per-shop bulk download on the track-detail screen. Multi-season scope lets drivers look back at recent series they raced previously.

## Scope summary

| Area | Change |
|---|---|
| **Schema** | None (already supports multi-season via existing `Season` + `SeasonWeek` tables) |
| **Seed** | Add 3 historical seasons (26S1, 25S4, 25S3); mark active flag |
| **Scrapers** | 5 scrapers gain `--year=YYYY --quarter=N` flag; 4 of 5 support historical natively; HYMO is current-only |
| **Backfill** | New `scripts/backfill-seasons.ts` + `npm run backfill:seasons`; production via `/api/ingest?year=...&quarter=...` |
| **API** | 2 new routes (`/api/picker/seasons`, `/api/picker/tracks-by-class`); 6 existing picker routes gain optional `?year&quarter` params |
| **Bridge UI** | Picker tab fully rewritten — state machine for 3 views (weeks / tracks / track-detail) inside the existing tab |
| **Bulk + Manage + Settings tabs** | Unchanged |
| **Web app** | Unchanged (Active season remains the only displayed season on web routes) |
| **Tests** | No new automated tests — `tsc --noEmit` + `next build` + manual curl + Tauri smoke (matches project convention) |
| **Deploy** | Web first (additive), then `db:seed` once, then `/api/ingest` per-season backfills, then tag a new bridge release |

## Decisions made during brainstorming

1. **Multi-season real backfill** (not a fake/placeholder dropdown).
2. **History depth: last 4 seasons** (26S2, 26S1, 25S4, 25S3).
3. **Single big spec** — UI redesign + scraper backfill ship together.
4. **Week 13** shown only when it has setups; default grid is 12 cards.
5. **Class accordions, all collapsed by default** on the track-detail screen.
6. **Per-class-per-shop bulk** download buttons (up to 5 chips per class section header).
7. **Bulk Download tab kept as-is** (whole-week bulk is a different scope than the new per-class bulk).
8. **Approach A** (in-tab state machine, season selector inside Picker tab, additive backend query params).

## Section 1 — Data layer

### Schema

No changes. `Season(year, quarter, label, isActive)` and `SeasonWeek(seasonId, weekNum)` already support multi-season. `SetupListing` joins via `seasonWeekId` so it's natively partitioned.

Adding 3 new `Season` rows + 39 new `SeasonWeek` rows (3 seasons × 13 weeks).

### Seed update (`lib/seed.ts`)

Replace the single-season `CURRENT_SEASON` constant with an array. Idempotent via existing upserts.

```typescript
const SEASONS = [
  { year: 2026, quarter: 2, label: "2026 S2", isActive: true },
  { year: 2026, quarter: 1, label: "2026 S1", isActive: false },
  { year: 2025, quarter: 4, label: "2025 S4", isActive: false },
  { year: 2025, quarter: 3, label: "2025 S3", isActive: false },
];
```

For each season: upsert; create 13 SeasonWeek rows; explicit `update: { isActive }` clause so toggling the active flag re-seeds correctly when the active season rolls over.

### Per-shop historical feasibility

| Shop | Multi-season | Mechanism | Notes |
|---|---|---|---|
| Grid-and-Go | ✅ | `?year=YYYY&season=N` query string | Confirmed round 2 |
| GO Setups | ✅ | Tab name template `<YY>S<N> WEEK <W>` | Existing scraper already iterates weeks |
| Majors Garage | ✅ | Bubble.io `constraints.Year` + `constraints.Season` | Existing scraper filters by current — extend to accept params |
| P1Doks | ✅ | JSON body `filters.Year._eq` + `filters.Season._eq` | Existing scraper filters by current — extend to accept params |
| HYMO | ⚠️ probe needed | API likely current-only | Plan calls for a 10-min probe early in implementation. If confirmed: backend logs a skip for non-current seasons; UI dims HYMO chip on historical seasons |

### Storage impact

Approx 4× current row count: ~2,200 listings × 4 seasons ≈ 8,800 listings. Production volume currently uses 248 KB; after backfill ~1 MB. Negligible.

### Active-season marker

`Season.isActive` is currently unused. Set to `true` on the most-recent season; `false` on the rest. The new season selector defaults to the active season. The weekly cron (`/api/ingest`) keeps scraping the active season (no change).

## Section 2 — API surface

### New routes

#### `GET /api/picker/seasons`

```typescript
{
  seasons: [
    { year: number; quarter: number; label: string; setupCount: number }
  ]
}
```

Ordered by year DESC, quarter DESC. Powers the season `<select>` dropdown. Public; CORS `*`; `dynamic = "force-dynamic"`.

#### `GET /api/picker/tracks-by-class?year=YYYY&quarter=N&weekNum=W&trackId=T`

The class-grouped track-detail payload, one fetch:

```typescript
{
  trackName: string;
  classes: [
    {
      carClass: string;  // "GT3"
      cars: [
        {
          id: number;
          name: string;
          iracingFolderName: string | null;
          shops: [
            {
              shopSlug: string;       // "grid-and-go"
              shopName: string;       // "Grid-and-Go"
              datapackId: string | null;
              externalId: string | null;
              listingUrl: string;     // for "Open setup" deep links
            }
          ]
        }
      ]
    }
  ]
}
```

**IDs only — no manifest pre-fetching.** Manifests for individual GnG datapacks fetch lazily via the existing `/api/files/<id>/zip` route during the actual download flow. This avoids triggering N simultaneous Cognito-gated GnG fetches when a user opens a class accordion.

Public; CORS `*`; `dynamic = "force-dynamic"`.

### Modified routes (all additive; defaults preserve current behaviour)

| Route | New params | Effect |
|---|---|---|
| `/api/picker/weeks` | `?year=YYYY&quarter=N` | Filter weeks to that season; returns weeks 1-12 always + week 13 only if `setupCount > 0` |
| `/api/picker/tracks` | `?year=YYYY&quarter=N` | Filter tracks to that season's week |
| `/api/picker/cars` | `?year=YYYY&quarter=N` | Filter cars to that season's week+track |
| `/api/picker/files` | `?year=YYYY&quarter=N` | Resolve correct `seasonWeekId` for the chosen season |
| `/api/picker/classes` | `?year=YYYY&quarter=N` | Filter carClass distinct list to that season |
| `/api/picker/all-cars` | (no change) | Operates on `Car` table which is season-agnostic |

### Validation

- `weekNum`: 1-13 (existing).
- `quarter`: 1-4. Reject otherwise with 400.
- `year`: 2020-2030 (defensive — rejects pre-iRacing-era and far-future).
- Missing params → fall back to active season (preserves existing curl call sites).

### `lib/compare-data.ts`

The four exported functions (`getWeekList`, `getTrackList`, `getTrackCompareData`, `getCompareData`) gain an optional `seasonId` filter. Default: current active season. Web routes don't pass it — no web-side UI rewrite this round.

### `/api/ingest` extension

Optional `?year=YYYY&quarter=N` query params. Missing → active season (existing behaviour, weekly cron unaffected). With params set: runs the requested scrapers against that season's data. Used for production backfill via curl.

### Backward compatibility

Every existing call site (current Bulk tab, current Picker tab pre-rewrite, web routes, the weekly cron) keeps working — query params are optional with active-season defaults.

## Section 3 — Bridge frontend (Picker tab)

### State machine inside the Picker tab

```typescript
type PickerView =
  | { kind: "weeks" }
  | { kind: "tracks"; weekNum: number }
  | { kind: "track-detail"; weekNum: number; trackId: number };
```

Season `{year, quarter}` is sibling state, not nested in `PickerView`. Changing the season resets `PickerView` to `weeks`. Initial state: active season + `{ kind: "weeks" }`. Season selection is in-memory only (resets to active each session — no persistence).

### New / changed files

```
bridge-app/src/screens/Picker.tsx           # rewritten; owns season + view state + breadcrumb
bridge-app/src/screens/picker/WeeksView.tsx # season <select> + season summary + week cards
bridge-app/src/screens/picker/TracksView.tsx # breadcrumb back + track cards (sorted setupCount DESC)
bridge-app/src/screens/picker/TrackDetailView.tsx # breadcrumb back + track header + class accordions
bridge-app/src/screens/picker/ClassAccordion.tsx  # collapsible class section + 5 shop chips + expandable car list
bridge-app/src/screens/picker/CarShopCell.tsx     # per-(car, shop) cell — name + per-car download button
```

### Types (`bridge-app/src/types.ts` additions)

```typescript
export interface Season {
  year: number;
  quarter: number;
  label: string;
  setupCount: number;
}

export interface CarShopRef {
  shopSlug: string;
  shopName: string;
  datapackId: string | null;
  externalId: string | null;
  listingUrl: string;
}

export interface ClassGroup {
  carClass: string;
  cars: Array<{
    id: number;
    name: string;
    iracingFolderName: string | null;
    shops: CarShopRef[];
  }>;
}

export interface TrackByClass {
  trackName: string;
  classes: ClassGroup[];
}
```

### Reused components

Borrow visual treatment from the web app's `WeekCard.tsx` / `TrackCard.tsx`. Bridge uses inline styles so we copy the styling tokens (`h-24`, `flex-col justify-between`, dim-when-zero) into bridge-local inline styles.

### Download flow on per-class-per-shop "Download all" chip click

1. Bridge has the full `TrackByClass` payload (all GnG `datapackId`s + HYMO `externalId`s in the class).
2. For each car in the class whose `shops[]` has a usable file ref for the chosen shop, the bridge calls `download_setups` Rust command sequentially (one car at a time).
3. Per-car progress shown inline in the class accordion header: `"3 / 8"` + small progress bar.
4. Per-car errors continue — logged to a per-class log panel (collapse-by-default beneath the section header).
5. Folder resolution per car: `overrides[car.name] ?? defaultFolderForCar(apiFolder)` — same priority order as today's Bulk tab.
6. Cars missing iRacing folder mapping → skipped with a log entry pointing at Manage Folders.

### Shop chip disabled-state rules

- HYMO chip on non-current season → disabled; tooltip "HYMO doesn't expose historical setups".
- Any shop chip when 0 cars in this class have data from that shop → disabled.
- GO Setups / Majors Garage / P1Doks chips → disabled with tooltip "no file pipeline yet" (these shops show listings but have no auto-download — same as today).

### Breadcrumb pattern

Each non-root view has a top breadcrumb row: `← Back to weeks` or `← Back to tracks for Week 3`. Clicking transitions state. No browser back button used (Tauri is single-window; in-app state is the navigation source of truth).

### Unchanged

- **Bulk Download tab**: untouched. Different scope (whole-week bulk) still useful.
- **Manage Folders tab**: untouched.
- **Settings tab**: untouched.
- **App header + tab bar**: untouched.

## Section 4 — Scraper changes + backfill orchestration

### Per-shop library function signature

Each `lib/scrape/<shop>.ts` gains an optional `season` argument:

```typescript
export async function runFooScrape(
  prisma: PrismaClient,
  season?: { year: number; quarter: number }
): Promise<ScraperResult>
```

Default: active season. The CLI wrapper (`scripts/scrape-<shop>.ts`) parses `--year=YYYY --quarter=N` from `process.argv` (plain string manipulation; no `commander` dep — matches existing style).

### Per-shop upstream API mapping

- **Grid-and-Go**: pass `year` + `season` through to existing query string params.
- **GO Setups**: change tab-name template from hardcoded `"26S2 WEEK <W>"` to derived `` `${String(year).slice(-2)}S${quarter} WEEK ${weekNum}` ``.
- **Majors Garage**: set Bubble.io `constraints.Year` + `constraints.Season` predicates.
- **P1Doks**: set JSON body `filters.Year._eq` + `filters.Season._eq`.
- **HYMO**: probe first. If API really has no season filter, scraper logs `[hymo] skipped non-current season ${year}S${quarter}` and returns `{ fetched: 0, inserted: 0, updated: 0, errors: 0 }`. Bridge UI handles this gracefully via the disabled-chip rule.

### Backfill script — `scripts/backfill-seasons.ts` (new)

```typescript
const SEASONS = [
  { year: 2026, quarter: 2 },
  { year: 2026, quarter: 1 },
  { year: 2025, quarter: 4 },
  { year: 2025, quarter: 3 },
];
```

For each season: run `runHymoScrape → runGridAndGoScrape → runGosetupsScrape → runMajorsGarageScrape → runP1DoksScrape` sequentially. Calls `migrateTracks` + `migrateCars` once at the end. Idempotent via existing composite-key upserts.

Wired as `npm run backfill:seasons`. Operates against local `dev.db` for development.

### `/api/ingest` extension (for production backfill)

Adds optional `?year=YYYY&quarter=N` to existing route. Missing → active season. Lets operator hit production from curl without copying DB:

```bash
curl -X POST -H "Authorization: Bearer $INGEST_SECRET" \
  "$URL/api/ingest?shop=all&year=2025&quarter=4"
```

### Production rollout sequence

1. **Deploy code** — schema unchanged, no migration; new routes live; existing routes unchanged in behaviour.
2. **Run seed once on Railway** — adds 3 new `Season` + 39 new `SeasonWeek` rows. (`railway run npx tsx lib/seed.ts` or equivalent.)
3. **Backfill via curl** — one season at a time: `?year=2026&quarter=1`, then `2025/4`, then `2025/3`.
4. **Verify** — `GET /api/picker/seasons` returns 4 entries with non-zero `setupCount` for at least GnG / GO / MG / P1Doks across all 4 seasons (HYMO populates current season only).
5. **Tag a new bridge release** (`bridge-vX.Y.Z`) with the rewritten Picker.

## Section 5 — Error handling + edge cases

### HYMO + historical seasons

HYMO's catalog API returns current data only. Backend: `runHymoScrape` accepts the `season` arg; if non-current, returns immediately with zero counters and logs one skip line. UI: `/api/picker/seasons` aggregates across all shops — HYMO contributes 0 to historical seasons. On track-detail screen, HYMO chip dimmed with tooltip "HYMO only ships current-season setups" when `year/quarter !== activeSeason`.

### Partial coverage seasons

Older seasons may have data from some shops but not others. Class accordion renders only shops with data. If a class has zero cars in the chosen season → class section doesn't render. If a track has zero classes → "No setups for this track this week" empty state.

### Backfill failures (per-shop, per-season)

`/api/ingest?shop=all&year=Y&quarter=Q` already isolates per-shop errors in independent try/catch blocks. Same applies for multi-season backfill — one shop failing on one season doesn't abort the run; partial data is OK. Operator inspects `/api/ingest` response JSON to see which slot has `skipped: "..."` and re-runs just that shop+season.

### Bulk download per class — partial failures

When user clicks "Download all (Grid-and-Go)" on GT3, bridge iterates each car. Per-car failure (Cognito 401, S3 timeout, missing iracing folder) does NOT abort the whole class — loop continues. Accordion shows running counters: `"5 / 8 downloaded — 1 skipped, 2 errors"`. Click counter to expand per-car log. Same model as today's Bulk Download tab.

### Bridge network errors

Existing `setError` red-banner pattern covers `fetch_picker` failures. Season `<select>` fetch failure → show "Connect to server" banner and disable navigation until refetch succeeds (no offline cache).

### Empty states

| Condition | UI |
|---|---|
| `/api/picker/seasons` returns 0 entries | "No seasons available. Run `npm run db:seed`." (dev-only) |
| Selected season has 0 weeks with setups | All 12 cards dimmed with `(0 setups)` |
| Selected week has 0 tracks | "No setups this week." + back button |
| Selected track has 0 classes | "No setups for this track this week." |
| Class accordion with 0 downloadable shops | "No downloadable setups for this class." |

### iRacing folder mapping gaps

Already handled by existing flow: `download_setups` skips cars without a folder, logs an entry, continues. Bridge surfaces the gap inline in the per-class log.

### Auth gating reminder

`/api/files/<datapackId>/zip` and `/api/files/hymo/<productId>/zip` remain Basic-Auth-gated (round 21 + 30). Bridge sends `Authorization: Basic <admin creds>` from saved Settings. No new auth surface this round.

## Section 6 — Testing approach

**No automated tests are added this round.** Project has no test framework — verification matches the round 1-35 pattern (`tsc --noEmit` + `next build` + manual curl + Tauri smoke).

### Pre-deploy smoke (operator runs locally)

- `npm run lint` → green.
- `npm run build` → green; new routes appear in route table as dynamic ƒ.
- `cd bridge-app && npx tsc --noEmit` → green. (Rust compile is gated by GitHub Actions Windows MSI build.)
- `npm run db:seed` then `npm run backfill:seasons` against local `dev.db`. Expect `/api/picker/seasons` to return 4 entries with non-zero `setupCount` for at least 26S2.

### Post-deploy verification

- `GET /api/picker/seasons` → 4 entries; current season `setupCount` matches pre-deploy.
- `GET /api/picker/weeks?year=2025&quarter=4` → 13 entries (or 12 if Week 13 empty).
- `GET /api/picker/tracks-by-class?year=2025&quarter=4&weekNum=1&trackId=<any>` → at least one class.
- Bridge MSI install:
  1. Picker → season dropdown shows 4 entries.
  2. Default season (26S2) → 12-13 week cards render.
  3. Click a week → tracks render sorted by setupCount DESC.
  4. Click a track → class accordions render, all collapsed.
  5. Expand GT3 → 5 shop chips visible; HYMO active on current season, dimmed on historical.
  6. Click "Download all (Grid-and-Go)" → progress visible; setups land in `<iracingRoot>/<carFolder>/<seasonLabel>/<trackSlug>/grid-and-go/`.
- Regression: Bulk Download / Manage Folders / Settings tabs all function. Web pages (`/`, `/week/3/track/28?carClass=GT3`) still 200.

### Risk assessment

- **`/api/ingest` weekly cron** — new optional params default to active season; cron URL doesn't change. Near-zero risk.
- **`lib/compare-data.ts` web app** — optional `seasonId` defaults to active season. Web routes don't pass it. Defaults preserve current behaviour. Verified via curl regression in post-deploy.
- **Bridge tab regression** — Bulk + Manage + Settings tabs unchanged. Only Picker tab is rewritten.

## Open questions / out of scope

- **Web app multi-season UI** — out of scope. Web routes render the active season only. A future round can add a season selector to the website if drivers ask for it.
- **HYMO historical scraping** — left as a probe-during-implementation task. If a workaround surfaces (alternative API endpoint, exported JSON file, etc.) it can be added in a follow-up round.
- **Active-season rollover automation** — when iRacing rolls to 26S3, an operator needs to update `lib/seed.ts` to add the new season and flip `isActive`. No automatic detection. Acceptable for quarterly cadence.
- **Bulk Download tab + multi-season** — out of scope this round. The Bulk tab keeps scraping the active season's weeks. A small follow-up could add a season dropdown to the Bulk tab.

## Implementation order

Recommend implementing in this order to keep each step independently verifiable:

1. `lib/seed.ts` — add 4 seasons.
2. `lib/compare-data.ts` — accept optional `seasonId`.
3. `/api/picker/seasons` route.
4. 6 existing picker routes — accept `?year&quarter`.
5. `/api/picker/tracks-by-class` route.
6. Per-shop scraper changes (5 files; HYMO probe first).
7. `scripts/backfill-seasons.ts` + `npm run backfill:seasons`.
8. `/api/ingest` — accept `?year&quarter`.
9. Bridge `Picker.tsx` rewrite + sub-screens.
10. Version bump bridge to next minor (0.5.0).
11. Deploy web → seed → backfill → bridge release.
