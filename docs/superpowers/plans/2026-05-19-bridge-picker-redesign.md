# Bridge Picker Redesign + Multi-Season Backfill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the bridge app's Picker tab from a dropdown cascade into a cards-everywhere flow (Season → Week → Track → Track-Detail-by-Class), and backfill 4 historical iRacing seasons (26S2, 26S1, 25S4, 25S3) so the season selector has real options.

**Architecture:** Multi-season backend (additive query params on existing routes + 2 new routes + scraper changes), then bridge UI rewrite (in-tab state machine, 6 new components). Schema is already multi-season capable — no migration. The current weekly cron keeps scraping the active season. Verification at every phase is `npm run lint` + `npm run build` + curl smoke + Tauri tsc.

**Tech Stack:** Next.js 16 (App Router, Turbopack), Prisma 7 + SQLite, undici for HTTP, Playwright (GnG only), Tauri v2 + React 18 + Vite 6.

**Spec source:** `docs/superpowers/specs/2026-05-19-bridge-picker-redesign-design.md`

**Verification model:** This project has NO automated test framework. Every task ends with concrete verification commands (lint, build, curl, sqlite query). Do not invent test files or test frameworks — that's out of scope.

---

## File map

### New files

| Path | Purpose |
|---|---|
| `lib/season-resolve.ts` | Helper: parse `?year&quarter` query params, resolve to a `Season` row from DB |
| `app/api/picker/seasons/route.ts` | New picker route — returns the season list |
| `app/api/picker/tracks-by-class/route.ts` | New picker route — class-grouped track-detail payload |
| `scripts/backfill-seasons.ts` | One-shot local backfill orchestrator |
| `scripts/probe-hymo-seasons.ts` | Probe to confirm HYMO catalog API is current-only |
| `bridge-app/src/screens/picker/WeeksView.tsx` | Season dropdown + week cards grid |
| `bridge-app/src/screens/picker/TracksView.tsx` | Track cards grid for one week |
| `bridge-app/src/screens/picker/TrackDetailView.tsx` | Class accordions for one (week, track) |
| `bridge-app/src/screens/picker/ClassAccordion.tsx` | One collapsible class section with 5 shop chips |
| `bridge-app/src/screens/picker/CarShopCell.tsx` | One (car, shop) cell — name + per-car download |
| `bridge-app/src/screens/picker/picker-helpers.ts` | Shared helpers (download orchestration, slugify) |

### Modified files

| Path | What changes |
|---|---|
| `lib/seed.ts` | Replace single `CURRENT_SEASON` const with array of 4 seasons; mark active |
| `lib/compare-data.ts` | Existing functions already accept `seasonId` — no signature changes; resolve via new helper at the route layer |
| `app/api/picker/weeks/route.ts` | Accept `?year&quarter` |
| `app/api/picker/tracks/route.ts` | Accept `?year&quarter` |
| `app/api/picker/cars/route.ts` | Accept `?year&quarter` |
| `app/api/picker/files/route.ts` | Accept `?year&quarter` |
| `app/api/picker/classes/route.ts` | Accept `?year&quarter` |
| `app/api/ingest/route.ts` | Accept `?year&quarter`; pass to scrapers |
| `lib/scrape/hymo.ts` | Accept optional `season` arg; current-only skip for non-active |
| `lib/scrape/grid-and-go.ts` | Accept optional `season` arg; pass through to `?year&season` query |
| `lib/scrape/gosetups.ts` | Accept optional `season` arg; scope tab walk to one season |
| `lib/scrape/majors-garage.ts` | Accept optional `season` arg; scope to one season |
| `lib/scrape/p1doks.ts` | Accept optional `season` arg; pass to filters |
| `scripts/scrape-hymo.ts` | Parse `--year=YYYY --quarter=N` |
| `scripts/scrape-grid-and-go.ts` | Parse `--year=YYYY --quarter=N` |
| `scripts/scrape-gosetups.ts` | Parse `--year=YYYY --quarter=N` |
| `scripts/scrape-majors-garage.ts` | Parse `--year=YYYY --quarter=N` |
| `scripts/scrape-p1doks.ts` | Parse `--year=YYYY --quarter=N` |
| `package.json` | Add `backfill:seasons` + `probe:hymo-seasons` scripts |
| `bridge-app/src/types.ts` | Add `Season`, `TrackByClass`, `ClassGroup`, `CarShopRef` types |
| `bridge-app/src/screens/Picker.tsx` | Full rewrite — state machine (weeks/tracks/track-detail), season picker |
| `bridge-app/package.json`, `bridge-app/src-tauri/tauri.conf.json`, `bridge-app/src-tauri/Cargo.toml` | Version bump 0.4.4 → 0.5.0 |
| `app/releases/page.tsx` | Prepend v0.5.0 to `FALLBACK_RELEASES` |

---

## Phase 1 — Data layer (Checkpoint 1)

Single task. End state: local DB has 4 Season rows + 52 SeasonWeek rows. Phase 1 is verifiable via sqlite.

### Task 1: Seed 4 seasons in `lib/seed.ts`

**Files:**
- Modify: `lib/seed.ts`

- [ ] **Step 1: Read current seed contents**

Run: `cat lib/seed.ts | sed -n '60,120p'`

Confirm the current structure has `CURRENT_SEASON = { year: 2026, quarter: 2, label: "2026 S2" }` and a single upsert + week-loop.

- [ ] **Step 2: Replace `CURRENT_SEASON` with `SEASONS` array**

Edit `lib/seed.ts`. Replace the line:

```typescript
const CURRENT_SEASON = { year: 2026, quarter: 2, label: "2026 S2" };
```

with:

```typescript
const SEASONS = [
  { year: 2026, quarter: 2, label: "2026 S2", isActive: true },
  { year: 2026, quarter: 1, label: "2026 S1", isActive: false },
  { year: 2025, quarter: 4, label: "2025 S4", isActive: false },
  { year: 2025, quarter: 3, label: "2025 S3", isActive: false },
];
```

- [ ] **Step 3: Replace the single-season upsert + week-loop with a for-loop**

In `lib/seed.ts`, replace the block that currently does `const season = await prisma.season.upsert(...)` plus the `for (let weekNum = 1; weekNum <= 13; weekNum++)` loop. The new block:

```typescript
  for (const s of SEASONS) {
    const seasonRow = await prisma.season.upsert({
      where: { year_quarter: { year: s.year, quarter: s.quarter } },
      create: s,
      update: { label: s.label, isActive: s.isActive },
    });
    for (let weekNum = 1; weekNum <= 13; weekNum++) {
      await prisma.seasonWeek.upsert({
        where: { seasonId_weekNum: { seasonId: seasonRow.id, weekNum } },
        create: {
          seasonId: seasonRow.id,
          weekNum,
          label: weekNum === 13 ? "Week 13" : `Week ${weekNum}`,
        },
        update: {},
      });
    }
  }
  console.log(`Seeded ${SEASONS.length} seasons with 13 weeks each (${SEASONS.length * 13} weeks total).`);
```

- [ ] **Step 4: Run seed locally and verify**

Run: `npm run db:seed`

Expected output ends with:
```
Seeded 4 seasons with 13 weeks each (52 weeks total).
Verification:
  shops: 5
  categories: 6
  seasons: 4
  weeks: 52
```

- [ ] **Step 5: Sqlite sanity check**

Run: `sqlite3 ./dev.db "SELECT id, year, quarter, label, isActive FROM Season ORDER BY year DESC, quarter DESC;"`

Expected: 4 rows. `26S2 isActive=1`, others `isActive=0`.

Run: `sqlite3 ./dev.db "SELECT seasonId, COUNT(*) FROM SeasonWeek GROUP BY seasonId ORDER BY seasonId;"`

Expected: 4 rows, each with `13`.

- [ ] **Step 6: Commit**

```bash
git add lib/seed.ts
git commit -m "$(cat <<'EOF'
feat(round 36): seed 4 seasons (26S2, 26S1, 25S4, 25S3) for multi-season picker

Schema already supports multi-season; this just adds the rows. 26S2 keeps
isActive=true so the weekly cron + active-season fallback are unchanged.
Idempotent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Checkpoint 1 verification (before Phase 2):**
- `sqlite3 ./dev.db "SELECT COUNT(*) FROM Season;"` returns `4`.
- `sqlite3 ./dev.db "SELECT COUNT(*) FROM SeasonWeek;"` returns `52`.
- Re-running `npm run db:seed` is idempotent (no errors, same counts).
- `git log --oneline -1` shows the seed commit.

---

## Phase 2 — Backend API (Checkpoint 2)

8 tasks. End state: web routes accept `?year&quarter` everywhere they need season context; 2 new routes return season list + class-grouped track payload; `/api/ingest` accepts season override. All defaults preserve current behaviour (active season).

### Task 2: Add `lib/season-resolve.ts` helper

**Files:**
- Create: `lib/season-resolve.ts`

- [ ] **Step 1: Create the helper module**

Write to `lib/season-resolve.ts`:

```typescript
/**
 * Helpers for resolving the optional ?year&quarter query params on picker
 * routes to a concrete Season row from the DB.
 */
import { prisma } from "@/lib/db";

export type SeasonSelector = { year: number; quarter: number };

export type ResolvedSeason = {
  id: number;
  year: number;
  quarter: number;
  label: string;
};

/**
 * Parse `?year` + `?quarter` from URLSearchParams. Returns:
 *   - null if both missing (caller should use active-season fallback)
 *   - { error } if exactly one is provided, or values fail validation
 *   - SeasonSelector if both are valid
 */
export function parseSeasonParams(
  searchParams: URLSearchParams,
): SeasonSelector | null | { error: string } {
  const yearRaw = searchParams.get("year");
  const quarterRaw = searchParams.get("quarter");

  if (yearRaw == null && quarterRaw == null) return null;
  if (yearRaw == null || quarterRaw == null) {
    return { error: "year and quarter must both be set, or both omitted" };
  }

  const year = parseInt(yearRaw, 10);
  const quarter = parseInt(quarterRaw, 10);

  if (Number.isNaN(year) || year < 2020 || year > 2030) {
    return { error: "year must be an integer between 2020 and 2030" };
  }
  if (Number.isNaN(quarter) || quarter < 1 || quarter > 4) {
    return { error: "quarter must be an integer between 1 and 4" };
  }

  return { year, quarter };
}

/**
 * Resolve a SeasonSelector (or null = active fallback) to a Season row.
 * Returns null if no matching row exists.
 */
export async function resolveSeason(
  selector: SeasonSelector | null,
): Promise<ResolvedSeason | null> {
  if (selector) {
    const row = await prisma.season.findUnique({
      where: { year_quarter: { year: selector.year, quarter: selector.quarter } },
      select: { id: true, year: true, quarter: true, label: true },
    });
    return row;
  }
  const active = await prisma.season.findFirst({
    where: { isActive: true },
    select: { id: true, year: true, quarter: true, label: true },
  });
  if (active) return active;
  const latest = await prisma.season.findFirst({
    orderBy: [{ year: "desc" }, { quarter: "desc" }],
    select: { id: true, year: true, quarter: true, label: true },
  });
  return latest;
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npm run lint`

Expected: green (no TypeScript errors).

- [ ] **Step 3: Commit**

```bash
git add lib/season-resolve.ts
git commit -m "feat(round 36): add lib/season-resolve.ts helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3: Add `?year&quarter` to `/api/picker/weeks`

**Files:**
- Modify: `app/api/picker/weeks/route.ts`

- [ ] **Step 1: Replace the file with the season-aware version**

Replace the entire contents of `app/api/picker/weeks/route.ts` with:

```typescript
/**
 * GET /api/picker/weeks?year=YYYY&quarter=N
 * Public; CORS *. Missing params → active season fallback.
 */
import { NextRequest, NextResponse } from "next/server";
import { getWeekList } from "@/lib/compare-data";
import { parseSeasonParams, resolveSeason } from "@/lib/season-resolve";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: NextRequest) {
  const parsed = parseSeasonParams(request.nextUrl.searchParams);
  if (parsed && "error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: CORS_HEADERS });
  }

  const season = await resolveSeason(parsed);
  if (!season) return NextResponse.json({ weeks: [] }, { headers: CORS_HEADERS });

  try {
    const data = await getWeekList({ seasonId: season.id });
    const weeks = data.weeks.map((w) => ({
      weekNum: w.weekNum,
      label: w.label,
      setupCount: w.setupCount,
    }));
    return NextResponse.json({ weeks }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error("[picker/weeks] error:", (err as Error).message);
    return NextResponse.json({ error: "Failed to load weeks" }, { status: 500, headers: CORS_HEADERS });
  }
}
```

- [ ] **Step 2: Lint + build + curl smoke**

```bash
npm run lint
npm run build
# (Start npm run dev in another terminal if not running)
curl -s http://localhost:3000/api/picker/weeks | python3 -m json.tool | head -10
curl -s "http://localhost:3000/api/picker/weeks?year=2026&quarter=2" | python3 -m json.tool | head -5
curl -s "http://localhost:3000/api/picker/weeks?year=2026" -o /dev/null -w "%{http_code}\n"
# Expected: 400
curl -s "http://localhost:3000/api/picker/weeks?year=2050&quarter=2" -o /dev/null -w "%{http_code}\n"
# Expected: 400
```

- [ ] **Step 3: Commit**

```bash
git add app/api/picker/weeks/route.ts
git commit -m "feat(round 36): /api/picker/weeks accepts ?year&quarter

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 4: Add `?year&quarter` to `/api/picker/tracks`

**Files:**
- Modify: `app/api/picker/tracks/route.ts`

- [ ] **Step 1: Replace the file**

Replace the entire contents of `app/api/picker/tracks/route.ts` with:

```typescript
/**
 * GET /api/picker/tracks?weekNum=N&year=YYYY&quarter=N
 * Only tracks with setupCount > 0 are returned.
 */
import { NextRequest, NextResponse } from "next/server";
import { getTrackList } from "@/lib/compare-data";
import { parseSeasonParams, resolveSeason } from "@/lib/season-resolve";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const weekNumRaw = searchParams.get("weekNum");
  const weekNum = weekNumRaw ? parseInt(weekNumRaw, 10) : NaN;

  if (isNaN(weekNum) || weekNum < 1 || weekNum > 13) {
    return NextResponse.json({ error: "weekNum must be an integer between 1 and 13" }, { status: 400, headers: CORS_HEADERS });
  }

  const parsed = parseSeasonParams(searchParams);
  if (parsed && "error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: CORS_HEADERS });
  }

  const season = await resolveSeason(parsed);
  if (!season) return NextResponse.json({ tracks: [] }, { headers: CORS_HEADERS });

  try {
    const data = await getTrackList(weekNum, { seasonId: season.id });
    const tracks = data.tracks
      .filter((t) => t.setupCount > 0)
      .map((t) => ({ id: t.id, name: t.name, setupCount: t.setupCount }));
    return NextResponse.json({ tracks }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error("[picker/tracks] error:", (err as Error).message);
    return NextResponse.json({ error: "Failed to load tracks" }, { status: 500, headers: CORS_HEADERS });
  }
}
```

- [ ] **Step 2: Lint + curl smoke**

```bash
npm run lint
curl -s "http://localhost:3000/api/picker/tracks?weekNum=3" | python3 -m json.tool | head -5
curl -s "http://localhost:3000/api/picker/tracks?weekNum=3&year=2026&quarter=2" | python3 -m json.tool | head -5
curl -s "http://localhost:3000/api/picker/tracks?weekNum=3&year=2025&quarter=4" -o /dev/null -w "%{http_code}\n"
# Expected: 200 (with empty tracks array until backfill)
```

- [ ] **Step 3: Commit**

```bash
git add app/api/picker/tracks/route.ts
git commit -m "feat(round 36): /api/picker/tracks accepts ?year&quarter

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 5: Add `?year&quarter` to `/api/picker/cars`

**Files:**
- Modify: `app/api/picker/cars/route.ts`

- [ ] **Step 1: Replace the file**

Replace the entire contents of `app/api/picker/cars/route.ts` with:

```typescript
/**
 * GET /api/picker/cars?weekNum=N&trackId=T&year=YYYY&quarter=N
 */
import { NextRequest, NextResponse } from "next/server";
import { getTrackCompareData } from "@/lib/compare-data";
import { lookupIracingFolder } from "@/lib/iracing-car-folders";
import { parseSeasonParams, resolveSeason } from "@/lib/season-resolve";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const weekNumRaw = searchParams.get("weekNum");
  const trackIdRaw = searchParams.get("trackId");

  const weekNum = weekNumRaw ? parseInt(weekNumRaw, 10) : NaN;
  const trackId = trackIdRaw ? parseInt(trackIdRaw, 10) : NaN;

  if (isNaN(weekNum) || weekNum < 1 || weekNum > 13) {
    return NextResponse.json({ error: "weekNum must be an integer between 1 and 13" }, { status: 400, headers: CORS_HEADERS });
  }
  if (isNaN(trackId) || trackId < 1) {
    return NextResponse.json({ error: "trackId must be a positive integer" }, { status: 400, headers: CORS_HEADERS });
  }

  const parsed = parseSeasonParams(searchParams);
  if (parsed && "error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: CORS_HEADERS });
  }

  const season = await resolveSeason(parsed);
  if (!season) return NextResponse.json({ cars: [] }, { headers: CORS_HEADERS });

  try {
    const data = await getTrackCompareData(weekNum, trackId, { seasonId: season.id });
    const seen = new Set<number>();
    const cars = data.rows
      .filter((row) => {
        if (seen.has(row.carId)) return false;
        seen.add(row.carId);
        return true;
      })
      .map((row) => ({
        id: row.carId,
        name: row.carName,
        carClass: row.carClass,
        iracingFolderName: lookupIracingFolder(row.carName),
      }));
    return NextResponse.json({ cars }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error("[picker/cars] error:", (err as Error).message);
    return NextResponse.json({ error: "Failed to load cars" }, { status: 500, headers: CORS_HEADERS });
  }
}
```

- [ ] **Step 2: Lint + curl smoke**

```bash
npm run lint
curl -s "http://localhost:3000/api/picker/cars?weekNum=3&trackId=28" | python3 -m json.tool | head -10
curl -s "http://localhost:3000/api/picker/cars?weekNum=3&trackId=28&year=2026&quarter=2" | python3 -m json.tool | head -10
```

- [ ] **Step 3: Commit**

```bash
git add app/api/picker/cars/route.ts
git commit -m "feat(round 36): /api/picker/cars accepts ?year&quarter

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 6: Add `?year&quarter` to `/api/picker/files`

**Files:**
- Modify: `app/api/picker/files/route.ts`

- [ ] **Step 1: Read current route to identify the season-resolution block**

Run: `grep -n "seasons\|activeSeasonId" app/api/picker/files/route.ts`

You should see:
- A `prisma.season.findMany(...)` call near the top of the `try` block.
- `const activeSeasonId = seasons[0]?.id ?? null;`
- A `prisma.seasonWeek.findUnique` call using `activeSeasonId`.

- [ ] **Step 2: Add the import at the top**

In `app/api/picker/files/route.ts`, after the existing imports, add:

```typescript
import { parseSeasonParams, resolveSeason } from "@/lib/season-resolve";
```

- [ ] **Step 3: Replace the season-resolution block**

Find this block (inside the `GET` handler, at the top of the `try`):

```typescript
  try {
    // Resolve the active season's week row for this weekNum.
    const seasons = await prisma.season.findMany({
      orderBy: [{ year: "desc" }, { quarter: "desc" }],
      take: 1,
    });
    const activeSeasonId = seasons[0]?.id ?? null;

    if (!activeSeasonId) {
      return NextResponse.json({ files: [], iracingFolderName: null }, { headers: CORS_HEADERS });
    }

    const seasonWeek = await prisma.seasonWeek.findUnique({
      where: { seasonId_weekNum: { seasonId: activeSeasonId, weekNum } },
    });
```

Replace with:

```typescript
  const parsed = parseSeasonParams(request.nextUrl.searchParams);
  if (parsed && "error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: CORS_HEADERS });
  }

  try {
    const season = await resolveSeason(parsed);
    if (!season) {
      return NextResponse.json({ files: [], iracingFolderName: null }, { headers: CORS_HEADERS });
    }

    const seasonWeek = await prisma.seasonWeek.findUnique({
      where: { seasonId_weekNum: { seasonId: season.id, weekNum } },
    });
```

- [ ] **Step 4: Lint + curl smoke**

```bash
npm run lint
curl -s "http://localhost:3000/api/picker/files?weekNum=3&trackId=28&carId=3" | python3 -m json.tool | head -20
curl -s "http://localhost:3000/api/picker/files?weekNum=3&trackId=28&carId=3&year=2026&quarter=2" | python3 -m json.tool | head -20
# Both responses should be identical (both resolve to 26S2).
```

- [ ] **Step 5: Commit**

```bash
git add app/api/picker/files/route.ts
git commit -m "feat(round 36): /api/picker/files accepts ?year&quarter

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 7: Add `?year&quarter` to `/api/picker/classes`

**Files:**
- Modify: `app/api/picker/classes/route.ts`

- [ ] **Step 1: Replace the file**

Replace the entire contents of `app/api/picker/classes/route.ts` with:

```typescript
/**
 * GET /api/picker/classes?year=YYYY&quarter=N
 * Returns distinct carClass values that have ≥1 listing in the chosen season.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseSeasonParams, resolveSeason } from "@/lib/season-resolve";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: NextRequest) {
  const parsed = parseSeasonParams(request.nextUrl.searchParams);
  if (parsed && "error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: CORS_HEADERS });
  }

  const season = await resolveSeason(parsed);
  if (!season) return NextResponse.json({ classes: [] }, { headers: CORS_HEADERS });

  try {
    const listings = await prisma.setupListing.findMany({
      where: { seasonWeek: { seasonId: season.id } },
      select: { car: { select: { carClass: true } } },
      distinct: ["carId"],
    });
    const set = new Set<string>();
    for (const l of listings) {
      if (l.car?.carClass) set.add(l.car.carClass);
    }
    const classes = Array.from(set).filter((c) => c.length > 0).sort();
    return NextResponse.json({ classes }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error("[picker/classes] error:", (err as Error).message);
    return NextResponse.json({ error: "Failed to load classes" }, { status: 500, headers: CORS_HEADERS });
  }
}
```

- [ ] **Step 2: Lint + smoke**

```bash
npm run lint
curl -s "http://localhost:3000/api/picker/classes" | python3 -m json.tool
# Expected: { "classes": ["Formula", "GT2", "GT3", ...] }
curl -s "http://localhost:3000/api/picker/classes?year=2025&quarter=4" | python3 -m json.tool
# Expected: { "classes": [] } until backfill
```

- [ ] **Step 3: Commit**

```bash
git add app/api/picker/classes/route.ts
git commit -m "feat(round 36): /api/picker/classes accepts ?year&quarter

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 8: New route `/api/picker/seasons`

**Files:**
- Create: `app/api/picker/seasons/route.ts`

- [ ] **Step 1: Create the route**

Write to `app/api/picker/seasons/route.ts`:

```typescript
/**
 * GET /api/picker/seasons
 * Returns the list of seasons with aggregate setupCount per season.
 * Ordered: year DESC, quarter DESC.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET() {
  try {
    const seasons = await prisma.season.findMany({
      orderBy: [{ year: "desc" }, { quarter: "desc" }],
      select: { id: true, year: true, quarter: true, label: true },
    });

    const grouped = await prisma.setupListing.groupBy({
      by: ["seasonWeekId"],
      _count: { id: true },
    });

    const seasonWeeks = await prisma.seasonWeek.findMany({
      select: { id: true, seasonId: true },
    });
    const weekToSeason = new Map<number, number>();
    for (const w of seasonWeeks) weekToSeason.set(w.id, w.seasonId);

    const countBySeason = new Map<number, number>();
    for (const g of grouped) {
      const sid = weekToSeason.get(g.seasonWeekId);
      if (sid != null) countBySeason.set(sid, (countBySeason.get(sid) ?? 0) + g._count.id);
    }

    const result = seasons.map((s) => ({
      year: s.year,
      quarter: s.quarter,
      label: s.label,
      setupCount: countBySeason.get(s.id) ?? 0,
    }));

    return NextResponse.json({ seasons: result }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error("[picker/seasons] error:", (err as Error).message);
    return NextResponse.json({ error: "Failed to load seasons" }, { status: 500, headers: CORS_HEADERS });
  }
}
```

- [ ] **Step 2: Lint + build + smoke**

```bash
npm run lint
npm run build
curl -s http://localhost:3000/api/picker/seasons | python3 -m json.tool
# Expected: 4 entries; 26S2 has setupCount~2200, others have 0 until backfill.
```

- [ ] **Step 3: Commit**

```bash
git add app/api/picker/seasons/route.ts
git commit -m "feat(round 36): GET /api/picker/seasons

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 9: New route `/api/picker/tracks-by-class`

**Files:**
- Create: `app/api/picker/tracks-by-class/route.ts`

- [ ] **Step 1: Create the route**

Write to `app/api/picker/tracks-by-class/route.ts`:

```typescript
/**
 * GET /api/picker/tracks-by-class?weekNum=W&trackId=T&year=YYYY&quarter=N
 *
 * Returns the class-grouped track-detail payload used by the bridge app's
 * track-detail view. IDs only — no manifest pre-fetching.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { shopNameToSlug } from "@/lib/shop-slug";
import { validateDatapackId } from "@/lib/files-manifest";
import { lookupIracingFolder } from "@/lib/iracing-car-folders";
import { parseSeasonParams, resolveSeason } from "@/lib/season-resolve";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const GNG_URL_PREFIX = "https://app.grid-and-go.com/#/datapacks/";

function extractGngDatapackId(url: string): string | null {
  if (!url.startsWith(GNG_URL_PREFIX)) return null;
  const id = url.slice(GNG_URL_PREFIX.length).split("?")[0].trim();
  return validateDatapackId(id) ? id : null;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const weekNumRaw = searchParams.get("weekNum");
  const trackIdRaw = searchParams.get("trackId");

  const weekNum = weekNumRaw ? parseInt(weekNumRaw, 10) : NaN;
  const trackId = trackIdRaw ? parseInt(trackIdRaw, 10) : NaN;

  if (isNaN(weekNum) || weekNum < 1 || weekNum > 13) {
    return NextResponse.json({ error: "weekNum must be an integer between 1 and 13" }, { status: 400, headers: CORS_HEADERS });
  }
  if (isNaN(trackId) || trackId < 1) {
    return NextResponse.json({ error: "trackId must be a positive integer" }, { status: 400, headers: CORS_HEADERS });
  }

  const parsed = parseSeasonParams(searchParams);
  if (parsed && "error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: CORS_HEADERS });
  }

  try {
    const season = await resolveSeason(parsed);
    if (!season) {
      return NextResponse.json({ trackName: "", classes: [] }, { headers: CORS_HEADERS });
    }

    const seasonWeek = await prisma.seasonWeek.findUnique({
      where: { seasonId_weekNum: { seasonId: season.id, weekNum } },
    });

    const track = await prisma.track.findUnique({
      where: { id: trackId },
      select: { name: true },
    });

    if (!seasonWeek || !track) {
      return NextResponse.json({ trackName: track?.name ?? "", classes: [] }, { headers: CORS_HEADERS });
    }

    const listings = await prisma.setupListing.findMany({
      where: { seasonWeekId: seasonWeek.id, trackId },
      select: {
        url: true,
        externalId: true,
        car: { select: { id: true, name: true, carClass: true } },
        shop: { select: { name: true } },
      },
      orderBy: [
        { car: { carClass: "asc" } },
        { car: { name: "asc" } },
        { shopId: "asc" },
      ],
    });

    type CarEntry = {
      id: number;
      name: string;
      iracingFolderName: string | null;
      shops: Array<{
        shopSlug: string;
        shopName: string;
        datapackId: string | null;
        externalId: string | null;
        listingUrl: string;
      }>;
    };
    const byClass = new Map<string, Map<number, CarEntry>>();
    for (const l of listings) {
      const carClass = l.car.carClass || "";
      if (!byClass.has(carClass)) byClass.set(carClass, new Map());
      const carMap = byClass.get(carClass)!;
      if (!carMap.has(l.car.id)) {
        carMap.set(l.car.id, {
          id: l.car.id,
          name: l.car.name,
          iracingFolderName: lookupIracingFolder(l.car.name),
          shops: [],
        });
      }
      const car = carMap.get(l.car.id)!;
      const shopName = l.shop.name;
      const shopSlug = shopNameToSlug(shopName);
      car.shops.push({
        shopSlug,
        shopName,
        datapackId: extractGngDatapackId(l.url),
        externalId: l.externalId ?? null,
        listingUrl: l.url,
      });
    }

    const classes = Array.from(byClass.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([carClass, carMap]) => ({
        carClass,
        cars: Array.from(carMap.values()).sort((a, b) => a.name.localeCompare(b.name)),
      }));

    return NextResponse.json({ trackName: track.name, classes }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error("[picker/tracks-by-class] error:", (err as Error).message);
    return NextResponse.json({ error: "Failed to load track detail" }, { status: 500, headers: CORS_HEADERS });
  }
}
```

- [ ] **Step 2: Lint + build + smoke**

```bash
npm run lint
npm run build
curl -s "http://localhost:3000/api/picker/tracks-by-class?weekNum=3&trackId=28" | python3 -m json.tool | head -40
# Expected: { "trackName": "Hockenheimring", "classes": [...] }
```

- [ ] **Step 3: Commit**

```bash
git add app/api/picker/tracks-by-class/route.ts
git commit -m "feat(round 36): GET /api/picker/tracks-by-class

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 10: Add `?year&quarter` to `/api/ingest`

**Files:**
- Modify: `app/api/ingest/route.ts`

- [ ] **Step 1: Locate the scraper-dispatch block**

Run: `grep -n "runHymoScrape\|runGridAndGoScrape\|runGosetupsScrape\|runMajorsGarageScrape\|runP1DoksScrape" app/api/ingest/route.ts`

These are the call sites whose second argument we'll add.

- [ ] **Step 2: Add the import + season param parsing**

At the top of `app/api/ingest/route.ts`, after the existing imports, add:

```typescript
import { parseSeasonParams, resolveSeason } from "@/lib/season-resolve";
```

Inside the POST handler, AFTER the bearer-auth validation has passed (look for a comment like `// authenticated past this point` or the first prisma call), BEFORE the per-shop dispatch logic, add:

```typescript
  // Round 36: optional ?year&quarter override for backfill via curl.
  const parsedSeason = parseSeasonParams(request.nextUrl.searchParams);
  if (parsedSeason && "error" in parsedSeason) {
    return NextResponse.json({ error: parsedSeason.error }, { status: 400 });
  }
  const seasonOverride = await resolveSeason(parsedSeason);
  if (!seasonOverride) {
    return NextResponse.json({ error: "no season available -- run db:seed" }, { status: 500 });
  }
  const seasonArg = parsedSeason
    ? { year: parsedSeason.year, quarter: parsedSeason.quarter }
    : undefined;
```

- [ ] **Step 3: Update each scraper call to forward seasonArg**

Find each `await runHymoScrape(prisma)` call. Change to `await runHymoScrape(prisma, seasonArg)`. Same for `runGridAndGoScrape`, `runGosetupsScrape`, `runMajorsGarageScrape`, `runP1DoksScrape`.

- [ ] **Step 4: Add the season label to the response**

Find the response body object that contains `ok`, `shop`, `durationMs`, `hymo`, etc. Add a `season` field that captures the resolved season info. Example:

```typescript
return NextResponse.json({
  ok: ...,
  shop: ...,
  durationMs: ...,
  season: { year: seasonOverride.year, quarter: seasonOverride.quarter, label: seasonOverride.label },
  ...,
});
```

(There are multiple return paths; add to each.)

- [ ] **Step 5: Type-check**

```bash
npm run lint
```

NOTE: this will FAIL until Phase 3 modifies each scraper's signature. That's expected. Skip the commit for now — Phase 2 ends here unfinished, and Phase 3 closes the loop.

- [ ] **Step 6: Stage without committing**

```bash
git add app/api/ingest/route.ts
# Do NOT commit yet — wait until Phase 3 Task 17 commits the paired scraper changes.
```

**Checkpoint 2 verification (before Phase 3):**

Most routes are committed and working. `/api/ingest` is staged but not yet runnable until Phase 3. Smoke the rest:

```bash
curl -s http://localhost:3000/api/picker/weeks | python3 -m json.tool | head -3
curl -s http://localhost:3000/api/picker/seasons | python3 -m json.tool | head -8
curl -s "http://localhost:3000/api/picker/tracks-by-class?weekNum=3&trackId=28" | python3 -m json.tool | head -30
curl -s "http://localhost:3000/api/picker/weeks?year=2026" -o /dev/null -w "%{http_code}\n"  # 400
```

`git log --oneline | head -10` should show 7-8 new commits (helper + 6 routes + Phase 1 seed).

---

## Phase 3 — Scraper changes + backfill (Checkpoint 3)

7 tasks. End state: each scraper accepts optional `season` arg, backfill script populates 4 seasons locally, `/api/picker/seasons` returns 4 entries with non-zero counts.

### Task 11: HYMO probe (research only, no commit)

**Files:**
- Create: `scripts/probe-hymo-seasons.ts` (temporary)
- Modify: `package.json` (temporary)

- [ ] **Step 1: Add the npm script + probe file**

Edit `package.json` `"scripts"` section, add:

```json
    "probe:hymo-seasons": "tsx scripts/probe-hymo-seasons.ts"
```

Write to `scripts/probe-hymo-seasons.ts`:

```typescript
/**
 * Round 36 probe: confirm whether HYMO's catalog API exposes any way to
 * request historical seasons.
 */
import { fetch } from "undici";

const API = "https://api.hymosetups.com/api/v1/products/search";

async function probe() {
  console.log("Probing HYMO API for season filter support...\n");

  console.log("=== Baseline (category_id=1) ===");
  const baseline = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category_id: 1 }),
  });
  const baselineJson = (await baseline.json()) as {
    data?: { items?: Array<{ season?: { year: number; season_num: number } }>; count?: number };
  };
  const items = baselineJson.data?.items ?? [];
  console.log(`  items returned: ${items.length}`);
  const seasons = new Set<string>();
  for (const item of items) {
    if (item.season) seasons.add(`${item.season.year}S${item.season.season_num}`);
  }
  console.log(`  distinct seasons: ${Array.from(seasons).sort().join(", ")}\n`);

  const attempts = [
    { name: "season_id=1", body: { category_id: 1, season_id: 1 } },
    { name: "year+season_num", body: { category_id: 1, year: 2025, season_num: 3 } },
    { name: "season object", body: { category_id: 1, season: { year: 2025, season_num: 3 } } },
    { name: "filters.year+season_num", body: { category_id: 1, filters: { year: 2025, season_num: 3 } } },
  ];

  for (const attempt of attempts) {
    console.log(`=== ${attempt.name} ===`);
    try {
      const resp = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(attempt.body),
      });
      const json = (await resp.json()) as {
        data?: { items?: Array<{ season?: { year: number; season_num: number } }>; count?: number };
      };
      const rItems = json.data?.items ?? [];
      console.log(`  items returned: ${rItems.length}`);
      const rSeasons = new Set<string>();
      for (const item of rItems) {
        if (item.season) rSeasons.add(`${item.season.year}S${item.season.season_num}`);
      }
      console.log(`  seasons: ${Array.from(rSeasons).sort().join(", ")}`);
      if (rItems.length !== items.length) console.log(`  *** ITEM COUNT CHANGED ***`);
    } catch (err) {
      console.log(`  ERROR: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
    console.log();
  }

  console.log("Done. If counts unchanged → HYMO is current-only.");
}

probe().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the probe**

```bash
npm run probe:hymo-seasons
```

Record the outcome in your shell history (also paste into the Task 12 commit message later):
- All attempts return same item count + same seasons → HYMO is current-only.
- Any attempt shows "ITEM COUNT CHANGED" → revisit Task 12 to use that filter.

- [ ] **Step 3: Delete probe artifacts**

```bash
git checkout package.json
rm scripts/probe-hymo-seasons.ts
```

(Probe is a one-shot; keep it out of git history.)

### Task 12: HYMO scraper accepts optional `season` arg

**Files:**
- Modify: `lib/scrape/hymo.ts`
- Modify: `scripts/scrape-hymo.ts`

- [ ] **Step 1: Modify `runHymoScrape` signature**

In `lib/scrape/hymo.ts`, find:

```typescript
export async function runHymoScrape(prisma: PrismaClient): Promise<HymoScrapeResult> {
```

Replace with:

```typescript
export type SeasonArg = { year: number; quarter: number };

export async function runHymoScrape(
  prisma: PrismaClient,
  season?: SeasonArg,
): Promise<HymoScrapeResult> {
```

- [ ] **Step 2: Log the season-arg intent**

Immediately after `const startedAt = new Date();` add:

```typescript
  // Round 36: HYMO API has no season filter (probed). The scraper writes
  // each item to whichever Season row its season.year + season.season_num
  // points to — so adding new Season rows to DB lets HYMO populate them
  // naturally. The season arg is logged for traceability.
  if (season) {
    console.log(`HYMO scraper: season arg ${season.year}S${season.quarter} received — API has no season filter; writes all items to matching DB rows.`);
  }
```

(If the probe found a filter mechanism, modify the API body inside the function to use the working filter shape instead.)

- [ ] **Step 3: Rewrite the CLI wrapper**

Replace the contents of `scripts/scrape-hymo.ts` with:

```typescript
import "dotenv/config";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import path from "path";
import { runHymoScrape, type SeasonArg } from "../lib/scrape/hymo";

function parseSeasonFromArgv(): SeasonArg | undefined {
  const yearArg = process.argv.find((a) => a.startsWith("--year="));
  const quarterArg = process.argv.find((a) => a.startsWith("--quarter="));
  if (!yearArg && !quarterArg) return undefined;
  if (!yearArg || !quarterArg) {
    throw new Error("--year and --quarter must be provided together");
  }
  const year = parseInt(yearArg.split("=")[1], 10);
  const quarter = parseInt(quarterArg.split("=")[1], 10);
  if (Number.isNaN(year) || year < 2020 || year > 2030) {
    throw new Error("--year must be 2020-2030");
  }
  if (Number.isNaN(quarter) || quarter < 1 || quarter > 4) {
    throw new Error("--quarter must be 1-4");
  }
  return { year, quarter };
}

function getDbPath(): string {
  return process.env.DATABASE_PATH || path.resolve(process.cwd(), "dev.db");
}

const adapter = new PrismaBetterSqlite3({ url: `file:${getDbPath()}` });
const prisma = new PrismaClient({ adapter });

async function main() {
  const season = parseSeasonFromArgv();
  const result = await runHymoScrape(prisma, season);
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((e) => {
    console.error("Scraper failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 4: Lint + smoke**

```bash
npm run lint
npm run scrape:hymo
# Expected: clean run.
npm run scrape:hymo -- --year=2025 --quarter=4
# Expected: prints season arg log line then ingests current catalog
# (items get routed to their actual DB season rows).
```

- [ ] **Step 5: Stage**

```bash
git add lib/scrape/hymo.ts scripts/scrape-hymo.ts
# Don't commit yet — bundle with the other scraper changes in Task 17.
```

### Task 13: Grid-and-Go scraper accepts optional `season` arg

**Files:**
- Modify: `lib/scrape/grid-and-go.ts`
- Modify: `scripts/scrape-grid-and-go.ts`

- [ ] **Step 1: Add type export + modify signature**

At the top of `lib/scrape/grid-and-go.ts` (after the existing imports + constants but before any function), add:

```typescript
export type SeasonArg = { year: number; quarter: number };
```

Find:

```typescript
export async function runGridAndGoScrape(prisma: PrismaClient): Promise<GridAndGoScrapeResult> {
```

Replace with:

```typescript
export async function runGridAndGoScrape(
  prisma: PrismaClient,
  season?: SeasonArg,
): Promise<GridAndGoScrapeResult> {
```

- [ ] **Step 2: Replace the season lookup**

Find this block inside the function:

```typescript
  const season = await prisma.season.findFirst({
    orderBy: [{ year: "desc" }, { quarter: "desc" }],
    include: { weeks: true },
  });
  if (!season) {
    throw new Error("No Season rows -- run db:seed first.");
  }
  const weekByNum = new Map(season.weeks.map((w) => [w.weekNum, w]));
```

Replace with (renaming the local var to `seasonRow` to avoid shadowing the function arg):

```typescript
  const seasonRow = season
    ? await prisma.season.findUnique({
        where: { year_quarter: { year: season.year, quarter: season.quarter } },
        include: { weeks: true },
      })
    : await prisma.season.findFirst({
        orderBy: [{ year: "desc" }, { quarter: "desc" }],
        include: { weeks: true },
      });
  if (!seasonRow) {
    throw new Error(
      season
        ? `Season ${season.year} Q${season.quarter} not in DB -- run db:seed first.`
        : "No Season rows -- run db:seed first.",
    );
  }
  const weekByNum = new Map(seasonRow.weeks.map((w) => [w.weekNum, w]));
```

Find:

```typescript
    const seasonsToFetch: { year: number; season: number }[] = [
      { year: season.year, season: season.quarter },
    ];
```

Replace with:

```typescript
    const seasonsToFetch: { year: number; season: number }[] = [
      { year: seasonRow.year, season: seasonRow.quarter },
    ];
```

- [ ] **Step 3: Rewrite CLI wrapper**

Replace the contents of `scripts/scrape-grid-and-go.ts` with:

```typescript
import "dotenv/config";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import path from "path";
import { runGridAndGoScrape, type SeasonArg } from "../lib/scrape/grid-and-go";

function parseSeasonFromArgv(): SeasonArg | undefined {
  const yearArg = process.argv.find((a) => a.startsWith("--year="));
  const quarterArg = process.argv.find((a) => a.startsWith("--quarter="));
  if (!yearArg && !quarterArg) return undefined;
  if (!yearArg || !quarterArg) {
    throw new Error("--year and --quarter must be provided together");
  }
  const year = parseInt(yearArg.split("=")[1], 10);
  const quarter = parseInt(quarterArg.split("=")[1], 10);
  if (Number.isNaN(year) || year < 2020 || year > 2030) {
    throw new Error("--year must be 2020-2030");
  }
  if (Number.isNaN(quarter) || quarter < 1 || quarter > 4) {
    throw new Error("--quarter must be 1-4");
  }
  return { year, quarter };
}

function getDbPath(): string {
  return process.env.DATABASE_PATH || path.resolve(process.cwd(), "dev.db");
}

const adapter = new PrismaBetterSqlite3({ url: `file:${getDbPath()}` });
const prisma = new PrismaClient({ adapter });

async function main() {
  const season = parseSeasonFromArgv();
  const result = await runGridAndGoScrape(prisma, season);
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((e) => {
    console.error("Scraper failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 4: Lint + smoke**

```bash
npm run lint
npm run scrape:grid-and-go -- --year=2025 --quarter=4
# Expected: Cognito login + fetch /datapacks?year=2025&season=4
# Output: { fetched: N, inserted: N, updated: 0, errors: [] }
```

- [ ] **Step 5: Stage**

```bash
git add lib/scrape/grid-and-go.ts scripts/scrape-grid-and-go.ts
```

### Task 14: gosetups scraper accepts optional `season` arg

**Files:**
- Modify: `lib/scrape/gosetups.ts`
- Modify: `scripts/scrape-gosetups.ts`

- [ ] **Step 1: Add type + modify signature**

At the top of `lib/scrape/gosetups.ts` (after imports), add:

```typescript
export type SeasonArg = { year: number; quarter: number };
```

Find:

```typescript
export async function runGosetupsScrape(prisma: PrismaClient): Promise<GosetupsScrapeResult> {
```

Replace with:

```typescript
export async function runGosetupsScrape(
  prisma: PrismaClient,
  season?: SeasonArg,
): Promise<GosetupsScrapeResult> {
```

- [ ] **Step 2: Scope the seasons lookup**

Find:

```typescript
  const seasons = await prisma.season.findMany({
    orderBy: [{ year: "desc" }, { quarter: "desc" }],
    include: { weeks: true },
  });
  if (seasons.length === 0) {
    throw new Error("No Season rows -- run db:seed first.");
  }
```

Replace with:

```typescript
  const seasons = season
    ? await prisma.season.findMany({
        where: { year: season.year, quarter: season.quarter },
        include: { weeks: true },
      })
    : await prisma.season.findMany({
        orderBy: [{ year: "desc" }, { quarter: "desc" }],
        include: { weeks: true },
      });
  if (seasons.length === 0) {
    throw new Error(
      season
        ? `Season ${season.year} Q${season.quarter} not in DB -- run db:seed first.`
        : "No Season rows -- run db:seed first.",
    );
  }
```

- [ ] **Step 3: Rewrite CLI wrapper**

Replace the contents of `scripts/scrape-gosetups.ts` with the same wrapper template as Task 13, substituting `runGosetupsScrape` and the gosetups import path:

```typescript
import "dotenv/config";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import path from "path";
import { runGosetupsScrape, type SeasonArg } from "../lib/scrape/gosetups";

function parseSeasonFromArgv(): SeasonArg | undefined {
  const yearArg = process.argv.find((a) => a.startsWith("--year="));
  const quarterArg = process.argv.find((a) => a.startsWith("--quarter="));
  if (!yearArg && !quarterArg) return undefined;
  if (!yearArg || !quarterArg) throw new Error("--year and --quarter must be provided together");
  const year = parseInt(yearArg.split("=")[1], 10);
  const quarter = parseInt(quarterArg.split("=")[1], 10);
  if (Number.isNaN(year) || year < 2020 || year > 2030) throw new Error("--year must be 2020-2030");
  if (Number.isNaN(quarter) || quarter < 1 || quarter > 4) throw new Error("--quarter must be 1-4");
  return { year, quarter };
}

function getDbPath(): string {
  return process.env.DATABASE_PATH || path.resolve(process.cwd(), "dev.db");
}

const adapter = new PrismaBetterSqlite3({ url: `file:${getDbPath()}` });
const prisma = new PrismaClient({ adapter });

async function main() {
  const season = parseSeasonFromArgv();
  const result = await runGosetupsScrape(prisma, season);
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((e) => {
    console.error("Scraper failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 4: Lint + smoke**

```bash
npm run lint
npm run scrape:gosetups -- --year=2025 --quarter=4
# Expected: walks weeks 1-13 of "25S4 WEEK N" tabs; some skipped (sig matches default).
```

- [ ] **Step 5: Stage**

```bash
git add lib/scrape/gosetups.ts scripts/scrape-gosetups.ts
```

### Task 15: Majors Garage scraper accepts optional `season` arg

**Files:**
- Modify: `lib/scrape/majors-garage.ts`
- Modify: `scripts/scrape-majors-garage.ts`

- [ ] **Step 1: Read MG scraper around the season loop**

Run: `sed -n '625,690p' lib/scrape/majors-garage.ts`

Identify the `seasons = await prisma.season.findMany(...)` call and the `for (const season of seasons)` loop. Also look for the Bubble.io API request body construction (search for `"constraints"`).

- [ ] **Step 2: Add type + modify signature**

At the top of `lib/scrape/majors-garage.ts` (after imports), add:

```typescript
export type SeasonArg = { year: number; quarter: number };
```

Find the function signature `export async function runMajorsGarageScrape(prisma: PrismaClient)` and change to:

```typescript
export async function runMajorsGarageScrape(
  prisma: PrismaClient,
  season?: SeasonArg,
): Promise<MajorsGarageScrapeResult> {
```

(Adjust the return type name to whatever the existing return type is named — check the existing code.)

- [ ] **Step 3: Scope the season loop**

Find the `seasons = await prisma.season.findMany(...)` block and replace with the same pattern as Task 14 (filter to `{ where: { year: season.year, quarter: season.quarter } }` when `season` arg set, else findMany all).

The `for (const season of seasons)` loop variable conflicts with the new function arg. Rename the loop variable to `seasonRow`:

```typescript
  for (const seasonRow of seasons) {
    // ...existing loop body, but s/season./seasonRow./g inside this block
  }
```

Replace every `season.year`, `season.quarter`, `season.weeks` etc. INSIDE the loop with `seasonRow.year`, `seasonRow.quarter`, `seasonRow.weeks`.

- [ ] **Step 4: Update the Bubble.io constraints (if present)**

Look for the Bubble.io `constraints` array. It probably has `{ "key": "Year", ... }` and `{ "key": "Season", ... }` entries. Ensure those use `seasonRow.year` and `seasonRow.quarter` (or whatever values are appropriate after the rename).

- [ ] **Step 5: Rewrite CLI wrapper**

Same template as Task 14. Replace contents of `scripts/scrape-majors-garage.ts`:

```typescript
import "dotenv/config";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import path from "path";
import { runMajorsGarageScrape, type SeasonArg } from "../lib/scrape/majors-garage";

function parseSeasonFromArgv(): SeasonArg | undefined {
  const yearArg = process.argv.find((a) => a.startsWith("--year="));
  const quarterArg = process.argv.find((a) => a.startsWith("--quarter="));
  if (!yearArg && !quarterArg) return undefined;
  if (!yearArg || !quarterArg) throw new Error("--year and --quarter must be provided together");
  const year = parseInt(yearArg.split("=")[1], 10);
  const quarter = parseInt(quarterArg.split("=")[1], 10);
  if (Number.isNaN(year) || year < 2020 || year > 2030) throw new Error("--year must be 2020-2030");
  if (Number.isNaN(quarter) || quarter < 1 || quarter > 4) throw new Error("--quarter must be 1-4");
  return { year, quarter };
}

function getDbPath(): string {
  return process.env.DATABASE_PATH || path.resolve(process.cwd(), "dev.db");
}

const adapter = new PrismaBetterSqlite3({ url: `file:${getDbPath()}` });
const prisma = new PrismaClient({ adapter });

async function main() {
  const season = parseSeasonFromArgv();
  const result = await runMajorsGarageScrape(prisma, season);
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((e) => {
    console.error("Scraper failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 6: Lint + smoke**

```bash
npm run lint
npm run scrape:majors-garage -- --year=2025 --quarter=4
```

- [ ] **Step 7: Stage**

```bash
git add lib/scrape/majors-garage.ts scripts/scrape-majors-garage.ts
```

### Task 16: P1Doks scraper accepts optional `season` arg

**Files:**
- Modify: `lib/scrape/p1doks.ts`
- Modify: `scripts/scrape-p1doks.ts`

- [ ] **Step 1: Read P1Doks around the season selection**

Run: `sed -n '220,290p' lib/scrape/p1doks.ts`

Identify the `prisma.season.findFirst(...)` call and the API request body that includes `filters: { Year: ..., Season: ... }`.

- [ ] **Step 2: Add type + modify signature**

At the top, add:

```typescript
export type SeasonArg = { year: number; quarter: number };
```

Find the function declaration `export async function runP1DoksScrape(prisma: PrismaClient)` and change to:

```typescript
export async function runP1DoksScrape(
  prisma: PrismaClient,
  season?: SeasonArg,
): Promise<P1DoksScrapeResult> {
```

(Adjust return type name to existing.)

- [ ] **Step 3: Update season lookup**

Replace the season lookup with the same pattern as Task 13 (GnG):

```typescript
  const seasonRow = season
    ? await prisma.season.findUnique({
        where: { year_quarter: { year: season.year, quarter: season.quarter } },
        include: { weeks: true },
      })
    : await prisma.season.findFirst({
        orderBy: [{ year: "desc" }, { quarter: "desc" }],
        include: { weeks: true },
      });
  if (!seasonRow) {
    throw new Error(
      season
        ? `Season ${season.year} Q${season.quarter} not in DB -- run db:seed first.`
        : "No Season rows -- run db:seed first.",
    );
  }
```

Then ensure the API request body uses `seasonRow.year` and `seasonRow.quarter` instead of the previous variables.

- [ ] **Step 4: Rewrite CLI wrapper**

Replace contents of `scripts/scrape-p1doks.ts` with the same template as previous tasks, substituting `runP1DoksScrape` and the p1doks import.

- [ ] **Step 5: Lint + smoke**

```bash
npm run lint
npm run scrape:p1doks -- --year=2025 --quarter=4
```

- [ ] **Step 6: Stage**

```bash
git add lib/scrape/p1doks.ts scripts/scrape-p1doks.ts
```

### Task 17: Backfill script + commit everything

**Files:**
- Create: `scripts/backfill-seasons.ts`
- Modify: `package.json`

- [ ] **Step 1: Add npm script**

In `package.json`, under `"scripts"`, add:

```json
    "backfill:seasons": "tsx scripts/backfill-seasons.ts"
```

- [ ] **Step 2: Create the backfill orchestrator**

Write to `scripts/backfill-seasons.ts`:

```typescript
import "dotenv/config";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import path from "path";
import { runHymoScrape } from "../lib/scrape/hymo";
import { runGridAndGoScrape } from "../lib/scrape/grid-and-go";
import { runGosetupsScrape } from "../lib/scrape/gosetups";
import { runMajorsGarageScrape } from "../lib/scrape/majors-garage";
import { runP1DoksScrape } from "../lib/scrape/p1doks";
import { migrateTracks } from "../lib/migrate-tracks";
import { migrateCars } from "../lib/migrate-cars";

const SEASONS: Array<{ year: number; quarter: number }> = [
  { year: 2026, quarter: 2 },
  { year: 2026, quarter: 1 },
  { year: 2025, quarter: 4 },
  { year: 2025, quarter: 3 },
];

function getDbPath(): string {
  return process.env.DATABASE_PATH || path.resolve(process.cwd(), "dev.db");
}

const adapter = new PrismaBetterSqlite3({ url: `file:${getDbPath()}` });
const prisma = new PrismaClient({ adapter });

type ScraperFn = (
  prisma: PrismaClient,
  season?: { year: number; quarter: number },
) => Promise<{ fetched: number; inserted: number; updated: number; errors: string[] }>;

const SCRAPERS: Array<{ name: string; fn: ScraperFn }> = [
  { name: "HYMO", fn: runHymoScrape },
  { name: "Grid-and-Go", fn: runGridAndGoScrape },
  { name: "GO Setups", fn: runGosetupsScrape },
  { name: "Majors Garage", fn: runMajorsGarageScrape },
  { name: "P1Doks", fn: runP1DoksScrape },
];

async function main() {
  console.log("=== Backfill ===");
  console.log(`Seasons: ${SEASONS.map((s) => `${s.year}S${s.quarter}`).join(", ")}\n`);

  for (const season of SEASONS) {
    console.log(`\n--- ${season.year} S${season.quarter} ---`);
    for (const scraper of SCRAPERS) {
      console.log(`\n  > ${scraper.name}...`);
      try {
        const result = await scraper.fn(prisma, season);
        console.log(`    fetched=${result.fetched} inserted=${result.inserted} updated=${result.updated} errors=${result.errors.length}`);
      } catch (err) {
        console.error(`    FAILED: ${(err as Error).message}`);
      }
    }
  }

  console.log("\n--- Migration pass ---");
  const trackResult = await migrateTracks(prisma);
  console.log(`  Tracks: ${JSON.stringify(trackResult)}`);
  const carResult = await migrateCars(prisma);
  console.log(`  Cars: ${JSON.stringify(carResult)}`);

  console.log("\n=== Done ===");
}

main()
  .catch((e) => {
    console.error("Backfill failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 3: Lint final**

```bash
npm run lint
```

Expected: green. (The `/api/ingest` staged change from Task 10 now compiles because each scraper accepts an optional `season` arg.)

- [ ] **Step 4: Run the backfill locally**

```bash
npm run backfill:seasons
```

Wall-clock ~30-60 min total. Watch for per-shop counts per season. Acceptable: HYMO inserted=0 for 25S3/25S4/26S1 (per probe).

- [ ] **Step 5: Verify**

```bash
curl -s http://localhost:3000/api/picker/seasons | python3 -m json.tool
# Expected: 4 entries, all with non-zero setupCount
curl -s "http://localhost:3000/api/picker/weeks?year=2025&quarter=4" | python3 -m json.tool | head -10
# Expected: 13 weeks with non-zero counts for at least some weeks
```

- [ ] **Step 6: Commit Phase 2 + Phase 3 together**

```bash
git add app/api/ingest/route.ts scripts/backfill-seasons.ts package.json
git commit -m "$(cat <<'EOF'
feat(round 36): per-shop scraper season args + backfill orchestrator + /api/ingest season override

Each scraper accepts an optional { year, quarter }; CLI wrappers parse
--year=YYYY --quarter=N. Backfill orchestrator runs all 5 shops across 4
seasons sequentially. /api/ingest now forwards ?year&quarter to the scrapers
for production backfill via curl.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Checkpoint 3 verification (before Phase 4):**

```bash
curl -s http://localhost:3000/api/picker/seasons | python3 -c "
import json, sys
d = json.load(sys.stdin)
for s in d['seasons']:
    print(f\"{s['label']}: {s['setupCount']} setups\")
"
# All 4 seasons should have setupCount > 0 (HYMO contributes 0 to historical).

curl -s "http://localhost:3000/api/picker/tracks-by-class?weekNum=3&trackId=28&year=2025&quarter=4" | python3 -m json.tool | head -20
# Should return valid (possibly empty) classes array — no 500.
```

`git log --oneline -3` shows the scraper/backfill commit.

---

## Phase 4 — Bridge UI rewrite (Checkpoint 4)

7 tasks. End state: bridge Picker tab is a 3-view state machine with season dropdown, week/track cards, and class accordions. Tsc green; ready for `tauri build` in Phase 5.

### Task 18: Add new types to `bridge-app/src/types.ts`

**Files:**
- Modify: `bridge-app/src/types.ts`

- [ ] **Step 1: Append new types**

Append to the end of `bridge-app/src/types.ts`:

```typescript
// --- Round 36 additions (multi-season picker) ---

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

export interface CarInClass {
  id: number;
  name: string;
  iracingFolderName: string | null;
  shops: CarShopRef[];
}

export interface ClassGroup {
  carClass: string;
  cars: CarInClass[];
}

export interface TrackByClass {
  trackName: string;
  classes: ClassGroup[];
}

export type PickerView =
  | { kind: "weeks" }
  | { kind: "tracks"; weekNum: number }
  | { kind: "track-detail"; weekNum: number; trackId: number };
```

- [ ] **Step 2: Type-check**

```bash
cd bridge-app && npx tsc --noEmit
cd ..
```

- [ ] **Step 3: Stage**

```bash
git add bridge-app/src/types.ts
```

### Task 19: Picker helper module

**Files:**
- Create: `bridge-app/src/screens/picker/picker-helpers.ts`

- [ ] **Step 1: Create the helper module**

Create the directory if it doesn't exist:

```bash
mkdir -p bridge-app/src/screens/picker
```

Write to `bridge-app/src/screens/picker/picker-helpers.ts`:

```typescript
import { invoke } from "@tauri-apps/api/core";
import type { CarInClass, CarShopRef } from "../../types";
import { slugify, defaultFolderForCar } from "../../helpers";

export function seasonLabel(year: number, quarter: number): string {
  return `${String(year).slice(-2)}s${quarter}`;
}

export type ShopChipState = {
  enabled: boolean;
  reason: "no-cars" | "no-pipeline" | "hymo-historical" | null;
  carsWithFiles: CarInClass[];
};

const FILE_PIPELINE_SHOPS = new Set(["grid-and-go", "hymo"]);

export function evaluateShopChip(
  shopSlug: string,
  cars: CarInClass[],
  isCurrentSeason: boolean,
): ShopChipState {
  if (!FILE_PIPELINE_SHOPS.has(shopSlug)) {
    return { enabled: false, reason: "no-pipeline", carsWithFiles: [] };
  }
  if (shopSlug === "hymo" && !isCurrentSeason) {
    return { enabled: false, reason: "hymo-historical", carsWithFiles: [] };
  }
  const carsWithFiles = cars.filter((car) =>
    car.shops.some(
      (s) =>
        s.shopSlug === shopSlug &&
        ((shopSlug === "grid-and-go" && s.datapackId) ||
          (shopSlug === "hymo" && s.externalId)),
    ),
  );
  if (carsWithFiles.length === 0) {
    return { enabled: false, reason: "no-cars", carsWithFiles: [] };
  }
  return { enabled: true, reason: null, carsWithFiles };
}

export function buildDownloadArgs(opts: {
  car: CarInClass;
  shopSlug: string;
  trackName: string;
  iracingFolder: string;
  serverUrl: string;
  year: number;
  quarter: number;
}): Record<string, unknown> | null {
  const shopRef: CarShopRef | undefined = opts.car.shops.find((s) => s.shopSlug === opts.shopSlug);
  if (!shopRef) return null;

  let assetUrl: string | null = null;
  let resolvedDatapackId = "";

  if (opts.shopSlug === "grid-and-go" && shopRef.datapackId) {
    resolvedDatapackId = shopRef.datapackId;
    assetUrl = null;
  } else if (opts.shopSlug === "hymo" && shopRef.externalId) {
    assetUrl = `${opts.serverUrl}/api/files/hymo/${shopRef.externalId}/zip`;
  } else {
    return null;
  }

  return {
    carSlug: slugify(opts.car.name),
    seasonLabel: seasonLabel(opts.year, opts.quarter),
    trackSlug: slugify(opts.trackName),
    shopSlug: opts.shopSlug,
    datapackId: resolvedDatapackId,
    iracingFolderName: opts.iracingFolder,
    carName: opts.car.name,
    assetUrl,
  };
}

export async function runShopBulkDownload(opts: {
  shopSlug: string;
  cars: CarInClass[];
  trackName: string;
  serverUrl: string;
  year: number;
  quarter: number;
  overrides: Record<string, string>;
  onProgress: (event: {
    currentIndex: number;
    total: number;
    car: CarInClass;
    status: "ok" | "skipped" | "error";
    message: string;
  }) => void;
}): Promise<void> {
  const { shopSlug, cars, trackName, serverUrl, year, quarter, overrides, onProgress } = opts;
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    const folder = overrides[car.name] ?? defaultFolderForCar(car.iracingFolderName);
    if (!folder) {
      onProgress({
        currentIndex: i + 1,
        total: cars.length,
        car,
        status: "skipped",
        message: `${car.name} has no iRacing folder — set in Manage Folders`,
      });
      continue;
    }
    const args = buildDownloadArgs({
      car,
      shopSlug,
      trackName,
      iracingFolder: folder,
      serverUrl,
      year,
      quarter,
    });
    if (!args) {
      onProgress({
        currentIndex: i + 1,
        total: cars.length,
        car,
        status: "skipped",
        message: `${car.name} — no file ref for ${shopSlug}`,
      });
      continue;
    }
    try {
      const result = await invoke<{ savedTo: string; fileNames: string[] }>("download_setups", { args });
      const count = result.fileNames.length;
      onProgress({
        currentIndex: i + 1,
        total: cars.length,
        car,
        status: "ok",
        message: `${count} file${count !== 1 ? "s" : ""} → ${result.savedTo}`,
      });
    } catch (err) {
      onProgress({
        currentIndex: i + 1,
        total: cars.length,
        car,
        status: "error",
        message: String(err),
      });
    }
  }
}
```

- [ ] **Step 2: Type-check + stage**

```bash
cd bridge-app && npx tsc --noEmit
cd ..
git add bridge-app/src/screens/picker/picker-helpers.ts
```

### Task 20: WeeksView component

**Files:**
- Create: `bridge-app/src/screens/picker/WeeksView.tsx`

- [ ] **Step 1: Create the component**

Write to `bridge-app/src/screens/picker/WeeksView.tsx`:

```typescript
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { COLOR } from "../../styles";
import type { Season, Week } from "../../types";

interface Props {
  year: number;
  quarter: number;
  onSelectSeason: (year: number, quarter: number) => void;
  onSelectWeek: (weekNum: number) => void;
}

export function WeeksView({ year, quarter, onSelectSeason, onSelectWeek }: Props) {
  const [seasons, setSeasons] = useState<Season[] | null>(null);
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<{ seasons: Season[] }>("fetch_picker", { endpoint: "seasons" })
      .then((data) => setSeasons(data.seasons))
      .catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    setLoading(true);
    invoke<{ weeks: Week[] }>("fetch_picker", {
      endpoint: `weeks?year=${year}&quarter=${quarter}`,
    })
      .then((data) => setWeeks(data.weeks))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [year, quarter]);

  const currentSeasonValue = `${year}-${quarter}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      {error && (
        <div style={{
          padding: "0.5rem 0.75rem",
          backgroundColor: "#451a1a",
          border: `1px solid ${COLOR.red}`,
          borderRadius: 6,
          color: COLOR.red,
          fontSize: 13,
        }}>{error}</div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <label htmlFor="season-select" style={{
          fontSize: 13,
          fontWeight: 600,
          color: COLOR.muted,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}>Season</label>
        <select
          id="season-select"
          value={currentSeasonValue}
          onChange={(e) => {
            const [y, q] = e.target.value.split("-").map(Number);
            onSelectSeason(y, q);
          }}
          disabled={!seasons}
          style={{
            padding: "0.4rem 0.7rem",
            backgroundColor: COLOR.surface,
            border: `1px solid ${COLOR.border}`,
            borderRadius: 6,
            color: COLOR.text,
            fontSize: 14,
            minWidth: 180,
          }}
        >
          {seasons === null ? (
            <option>Loading…</option>
          ) : (
            seasons.map((s) => (
              <option key={`${s.year}-${s.quarter}`} value={`${s.year}-${s.quarter}`}>
                {s.label} ({s.setupCount} setups)
              </option>
            ))
          )}
        </select>
      </div>

      <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Pick a week</h1>

      {loading && <div style={{ color: COLOR.muted, fontSize: 13 }}>Loading weeks…</div>}

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
        gap: "0.75rem",
      }}>
        {weeks
          .filter((w) => w.weekNum !== 13 || w.setupCount > 0)
          .map((w) => {
            const dim = w.setupCount === 0;
            return (
              <button
                key={w.weekNum}
                onClick={() => !dim && onSelectWeek(w.weekNum)}
                disabled={dim}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  height: 96,
                  padding: "0.65rem 0.75rem",
                  backgroundColor: COLOR.surface,
                  border: `1px solid ${COLOR.border}`,
                  borderRadius: 8,
                  color: COLOR.text,
                  cursor: dim ? "default" : "pointer",
                  opacity: dim ? 0.4 : 1,
                  textAlign: "left",
                  transition: "transform 0.1s, box-shadow 0.1s",
                }}
                onMouseEnter={(e) => {
                  if (!dim) {
                    e.currentTarget.style.transform = "translateY(-1px)";
                    e.currentTarget.style.boxShadow = "0 2px 6px rgba(0,0,0,0.4)";
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "";
                  e.currentTarget.style.boxShadow = "";
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 700 }}>{w.label}</span>
                <span style={{ fontSize: 12, color: COLOR.muted }}>
                  {w.setupCount} {w.setupCount === 1 ? "setup" : "setups"}
                </span>
              </button>
            );
          })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check + stage**

```bash
cd bridge-app && npx tsc --noEmit
cd ..
git add bridge-app/src/screens/picker/WeeksView.tsx
```

### Task 21: TracksView component

**Files:**
- Create: `bridge-app/src/screens/picker/TracksView.tsx`

- [ ] **Step 1: Create the component**

Write to `bridge-app/src/screens/picker/TracksView.tsx`:

```typescript
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { COLOR } from "../../styles";
import type { Track } from "../../types";

interface Props {
  year: number;
  quarter: number;
  weekNum: number;
  onBack: () => void;
  onSelectTrack: (trackId: number, trackName: string) => void;
}

export function TracksView({ year, quarter, weekNum, onBack, onSelectTrack }: Props) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    invoke<{ tracks: Track[] }>("fetch_picker", {
      endpoint: `tracks?weekNum=${weekNum}&year=${year}&quarter=${quarter}`,
    })
      .then((data) => {
        const rows = Array.isArray(data.tracks) ? data.tracks : [];
        const sorted = [...rows].sort((a, b) => {
          const ac = a.setupCount ?? 0;
          const bc = b.setupCount ?? 0;
          if (bc !== ac) return bc - ac;
          return (a.name ?? "").localeCompare(b.name ?? "");
        });
        setTracks(sorted);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [year, quarter, weekNum]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <button
        onClick={onBack}
        style={{
          alignSelf: "flex-start",
          background: "none",
          border: "none",
          color: COLOR.accent,
          cursor: "pointer",
          fontSize: 13,
          padding: 0,
        }}
      >
        ← Back to weeks
      </button>

      <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
        Week {weekNum} — pick a track
      </h1>

      {error && (
        <div style={{
          padding: "0.5rem 0.75rem",
          backgroundColor: "#451a1a",
          border: `1px solid ${COLOR.red}`,
          borderRadius: 6,
          color: COLOR.red,
          fontSize: 13,
        }}>{error}</div>
      )}

      {loading && <div style={{ color: COLOR.muted, fontSize: 13 }}>Loading tracks…</div>}

      {!loading && tracks.length === 0 && !error && (
        <div style={{ color: COLOR.muted, fontSize: 13 }}>
          No setups for any track this week.
        </div>
      )}

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        gap: "0.75rem",
      }}>
        {tracks.map((t) => (
          <button
            key={t.id}
            onClick={() => onSelectTrack(t.id, t.name)}
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              height: 96,
              padding: "0.7rem 0.85rem",
              backgroundColor: COLOR.surface,
              border: `1px solid ${COLOR.border}`,
              borderRadius: 8,
              color: COLOR.text,
              cursor: "pointer",
              textAlign: "left",
              transition: "transform 0.1s, box-shadow 0.1s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "translateY(-1px)";
              e.currentTarget.style.boxShadow = "0 2px 6px rgba(0,0,0,0.4)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "";
              e.currentTarget.style.boxShadow = "";
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.25, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{t.name}</span>
            <span style={{ fontSize: 12, color: COLOR.muted }}>
              {t.setupCount} {t.setupCount === 1 ? "setup" : "setups"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check + stage**

```bash
cd bridge-app && npx tsc --noEmit
cd ..
git add bridge-app/src/screens/picker/TracksView.tsx
```

### Task 22: CarShopCell + ClassAccordion components

**Files:**
- Create: `bridge-app/src/screens/picker/CarShopCell.tsx`
- Create: `bridge-app/src/screens/picker/ClassAccordion.tsx`

- [ ] **Step 1: Create CarShopCell**

Write to `bridge-app/src/screens/picker/CarShopCell.tsx`:

```typescript
import { COLOR } from "../../styles";
import type { CarInClass } from "../../types";

interface Props {
  car: CarInClass;
}

export function CarShopCell({ car }: Props) {
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      gap: "0.35rem",
      padding: "0.5rem 0.75rem",
      borderTop: `1px solid ${COLOR.border}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{car.name}</span>
        <span style={{ fontSize: 11, color: COLOR.muted }}>
          {car.shops.length} {car.shops.length === 1 ? "shop" : "shops"}
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
        {car.shops.map((s) => (
          <a
            key={s.shopSlug}
            href={s.listingUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              fontSize: 11,
              color: COLOR.muted,
              textDecoration: "none",
              border: `1px solid ${COLOR.border}`,
              padding: "0.15rem 0.5rem",
              borderRadius: 999,
              backgroundColor: COLOR.bg,
            }}
            title={`Open ${s.shopName} listing in browser`}
          >
            {s.shopName}
          </a>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create ClassAccordion**

Write to `bridge-app/src/screens/picker/ClassAccordion.tsx`:

```typescript
import { useState } from "react";
import { COLOR } from "../../styles";
import type { ClassGroup, Settings } from "../../types";
import { CarShopCell } from "./CarShopCell";
import { evaluateShopChip, runShopBulkDownload } from "./picker-helpers";

const SHOPS_TO_SHOW = [
  { slug: "grid-and-go", label: "Grid-and-Go" },
  { slug: "hymo", label: "HYMO" },
  { slug: "gosetups", label: "GO Setups" },
  { slug: "majors-garage", label: "Majors Garage" },
  { slug: "p1doks", label: "P1Doks" },
];

interface ProgressState {
  currentIndex: number;
  total: number;
  ok: number;
  skipped: number;
  errors: number;
  log: Array<{ status: "ok" | "skipped" | "error"; car: string; message: string }>;
}

interface Props {
  group: ClassGroup;
  trackName: string;
  settings: Settings;
  overrides: Record<string, string>;
  isCurrentSeason: boolean;
  year: number;
  quarter: number;
}

export function ClassAccordion({
  group,
  trackName,
  settings,
  overrides,
  isCurrentSeason,
  year,
  quarter,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [downloadingShop, setDownloadingShop] = useState<string | null>(null);
  const [progressByShop, setProgressByShop] = useState<Record<string, ProgressState>>({});
  const [logsOpen, setLogsOpen] = useState<Record<string, boolean>>({});

  const shopStates = SHOPS_TO_SHOW.map((s) => ({
    ...s,
    state: evaluateShopChip(s.slug, group.cars, isCurrentSeason),
  }));

  async function runShop(shopSlug: string) {
    const target = shopStates.find((s) => s.slug === shopSlug);
    if (!target || !target.state.enabled) return;
    setDownloadingShop(shopSlug);
    setProgressByShop((prev) => ({
      ...prev,
      [shopSlug]: { currentIndex: 0, total: target.state.carsWithFiles.length, ok: 0, skipped: 0, errors: 0, log: [] },
    }));

    await runShopBulkDownload({
      shopSlug,
      cars: target.state.carsWithFiles,
      trackName,
      serverUrl: settings.serverUrl,
      year,
      quarter,
      overrides,
      onProgress: (ev) => {
        setProgressByShop((prev) => {
          const cur = prev[shopSlug] ?? { currentIndex: 0, total: ev.total, ok: 0, skipped: 0, errors: 0, log: [] };
          const next = {
            currentIndex: ev.currentIndex,
            total: ev.total,
            ok: cur.ok + (ev.status === "ok" ? 1 : 0),
            skipped: cur.skipped + (ev.status === "skipped" ? 1 : 0),
            errors: cur.errors + (ev.status === "error" ? 1 : 0),
            log: [...cur.log, { status: ev.status, car: ev.car.name, message: ev.message }],
          };
          return { ...prev, [shopSlug]: next };
        });
      },
    });

    setDownloadingShop(null);
  }

  return (
    <div style={{
      border: `1px solid ${COLOR.border}`,
      borderRadius: 8,
      backgroundColor: COLOR.surface,
      overflow: "hidden",
    }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          padding: "0.65rem 0.85rem",
          cursor: "pointer",
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <span style={{ fontSize: 12, color: COLOR.muted, width: 12 }}>
          {expanded ? "▾" : "▸"}
        </span>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{group.carClass}</span>
        <span style={{ color: COLOR.muted, fontSize: 12 }}>
          {group.cars.length} {group.cars.length === 1 ? "car" : "cars"}
        </span>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }} onClick={(e) => e.stopPropagation()}>
          {shopStates.map((s) => {
            const prog = progressByShop[s.slug];
            const running = downloadingShop === s.slug;
            const done = prog && !running && prog.currentIndex === prog.total;
            return (
              <button
                key={s.slug}
                onClick={() => runShop(s.slug)}
                disabled={!s.state.enabled || downloadingShop !== null}
                title={
                  s.state.reason === "no-pipeline"
                    ? "No file pipeline for this shop yet"
                    : s.state.reason === "hymo-historical"
                      ? "HYMO doesn't expose historical setups"
                      : s.state.reason === "no-cars"
                        ? `No ${group.carClass} cars from ${s.label} at this track`
                        : undefined
                }
                style={{
                  padding: "0.25rem 0.6rem",
                  fontSize: 11,
                  border: `1px solid ${s.state.enabled ? COLOR.border : "transparent"}`,
                  borderRadius: 999,
                  backgroundColor: s.state.enabled
                    ? running ? "#172554" : done ? "#052e16" : COLOR.bg
                    : "transparent",
                  color: s.state.enabled
                    ? running ? COLOR.accent : done ? COLOR.green : COLOR.text
                    : COLOR.muted,
                  cursor: s.state.enabled && downloadingShop === null ? "pointer" : "not-allowed",
                  opacity: s.state.enabled ? 1 : 0.5,
                }}
              >
                {running
                  ? `${prog?.currentIndex ?? 0} / ${prog?.total ?? 0}`
                  : done
                    ? `Done (${prog?.ok ?? 0})`
                    : `Download all (${s.label})`}
              </button>
            );
          })}
        </div>
      </div>

      {Object.entries(progressByShop).map(([slug, prog]) => {
        const open = logsOpen[slug] ?? false;
        if (prog.log.length === 0 && downloadingShop !== slug) return null;
        return (
          <div key={slug} style={{
            borderTop: `1px solid ${COLOR.border}`,
            padding: "0.4rem 0.85rem",
            fontSize: 11,
            color: COLOR.muted,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}
              onClick={() => setLogsOpen((p) => ({ ...p, [slug]: !open }))}
            >
              <span>{open ? "▾" : "▸"} {SHOPS_TO_SHOW.find((s) => s.slug === slug)?.label}</span>
              <span>{prog.ok} ok</span>
              {prog.skipped > 0 && <span style={{ color: COLOR.yellow }}>{prog.skipped} skipped</span>}
              {prog.errors > 0 && <span style={{ color: COLOR.red }}>{prog.errors} errors</span>}
            </div>
            {open && (
              <div style={{ marginTop: "0.35rem", maxHeight: 200, overflowY: "auto" }}>
                {prog.log.map((entry, i) => (
                  <div key={i} style={{ paddingLeft: "1rem" }}>
                    <span style={{
                      color: entry.status === "ok" ? COLOR.green : entry.status === "error" ? COLOR.red : COLOR.yellow,
                      fontWeight: 700,
                    }}>
                      {entry.status === "ok" ? "+" : entry.status === "error" ? "!" : "-"}
                    </span>{" "}
                    {entry.car} — {entry.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {expanded && group.cars.map((car) => (
        <CarShopCell key={car.id} car={car} />
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Type-check + stage**

```bash
cd bridge-app && npx tsc --noEmit
cd ..
git add bridge-app/src/screens/picker/CarShopCell.tsx bridge-app/src/screens/picker/ClassAccordion.tsx
```

### Task 23: TrackDetailView component

**Files:**
- Create: `bridge-app/src/screens/picker/TrackDetailView.tsx`

- [ ] **Step 1: Create the component**

Write to `bridge-app/src/screens/picker/TrackDetailView.tsx`:

```typescript
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { COLOR } from "../../styles";
import type { TrackByClass, Settings } from "../../types";
import { ClassAccordion } from "./ClassAccordion";

interface Props {
  year: number;
  quarter: number;
  weekNum: number;
  trackId: number;
  isCurrentSeason: boolean;
  settings: Settings;
  overrides: Record<string, string>;
  onBack: () => void;
}

export function TrackDetailView({
  year,
  quarter,
  weekNum,
  trackId,
  isCurrentSeason,
  settings,
  overrides,
  onBack,
}: Props) {
  const [data, setData] = useState<TrackByClass | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    invoke<TrackByClass>("fetch_picker", {
      endpoint: `tracks-by-class?weekNum=${weekNum}&trackId=${trackId}&year=${year}&quarter=${quarter}`,
    })
      .then((d) => setData(d))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [year, quarter, weekNum, trackId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <button
        onClick={onBack}
        style={{
          alignSelf: "flex-start",
          background: "none",
          border: "none",
          color: COLOR.accent,
          cursor: "pointer",
          fontSize: 13,
          padding: 0,
        }}
      >
        ← Back to tracks
      </button>

      <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
        {data?.trackName || "Loading…"}
      </h1>
      <div style={{ color: COLOR.muted, fontSize: 13 }}>
        Week {weekNum} — pick a class to expand or download in bulk
      </div>

      {error && (
        <div style={{
          padding: "0.5rem 0.75rem",
          backgroundColor: "#451a1a",
          border: `1px solid ${COLOR.red}`,
          borderRadius: 6,
          color: COLOR.red,
          fontSize: 13,
        }}>{error}</div>
      )}

      {loading && <div style={{ color: COLOR.muted, fontSize: 13 }}>Loading classes…</div>}

      {!loading && data && data.classes.length === 0 && (
        <div style={{ color: COLOR.muted, fontSize: 13 }}>
          No setups for this track this week.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
        {data?.classes.map((g) => (
          <ClassAccordion
            key={g.carClass}
            group={g}
            trackName={data.trackName}
            settings={settings}
            overrides={overrides}
            isCurrentSeason={isCurrentSeason}
            year={year}
            quarter={quarter}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check + stage**

```bash
cd bridge-app && npx tsc --noEmit
cd ..
git add bridge-app/src/screens/picker/TrackDetailView.tsx
```

### Task 24: Rewrite `bridge-app/src/screens/Picker.tsx`

**Files:**
- Modify: `bridge-app/src/screens/Picker.tsx`

- [ ] **Step 1: Replace the entire file**

Replace the contents of `bridge-app/src/screens/Picker.tsx` with:

```typescript
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { COLOR, styles } from "../styles";
import type { Settings, Season, PickerView } from "../types";
import { WeeksView } from "./picker/WeeksView";
import { TracksView } from "./picker/TracksView";
import { TrackDetailView } from "./picker/TrackDetailView";

interface Props {
  settings: Settings;
  overrides: Record<string, string>;
  onOverridesChanged?: () => void;
}

export function PickerScreen({ settings, overrides }: Props) {
  const [year, setYear] = useState<number | null>(null);
  const [quarter, setQuarter] = useState<number | null>(null);
  const [activeYear, setActiveYear] = useState<number | null>(null);
  const [activeQuarter, setActiveQuarter] = useState<number | null>(null);
  const [view, setView] = useState<PickerView>({ kind: "weeks" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<{ seasons: Season[] }>("fetch_picker", { endpoint: "seasons" })
      .then((data) => {
        const first = data.seasons[0];
        if (first) {
          setYear(first.year);
          setQuarter(first.quarter);
          setActiveYear(first.year);
          setActiveQuarter(first.quarter);
        } else {
          setError("No seasons available. Run `npm run db:seed` on the server.");
        }
      })
      .catch((err) => setError(String(err)));
  }, []);

  function handleSelectSeason(y: number, q: number) {
    setYear(y);
    setQuarter(q);
    setView({ kind: "weeks" });
  }

  function handleSelectWeek(weekNum: number) {
    setView({ kind: "tracks", weekNum });
  }

  function handleSelectTrack(trackId: number) {
    if (view.kind !== "tracks") return;
    setView({ kind: "track-detail", weekNum: view.weekNum, trackId });
  }

  function backToWeeks() {
    setView({ kind: "weeks" });
  }

  function backToTracks() {
    if (view.kind === "track-detail") {
      setView({ kind: "tracks", weekNum: view.weekNum });
    }
  }

  const isCurrentSeason =
    year !== null &&
    quarter !== null &&
    year === activeYear &&
    quarter === activeQuarter;

  return (
    <div style={styles.screen}>
      {error && (
        <div style={styles.errorBanner} role="alert">
          <span style={{ flex: 1 }}>{error}</span>
          <button onClick={() => setError(null)} style={styles.errorClose} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}

      {year === null || quarter === null ? (
        <div style={{ color: COLOR.muted, fontSize: 13 }}>Loading seasons…</div>
      ) : view.kind === "weeks" ? (
        <WeeksView
          year={year}
          quarter={quarter}
          onSelectSeason={handleSelectSeason}
          onSelectWeek={handleSelectWeek}
        />
      ) : view.kind === "tracks" ? (
        <TracksView
          year={year}
          quarter={quarter}
          weekNum={view.weekNum}
          onBack={backToWeeks}
          onSelectTrack={handleSelectTrack}
        />
      ) : (
        <TrackDetailView
          year={year}
          quarter={quarter}
          weekNum={view.weekNum}
          trackId={view.trackId}
          isCurrentSeason={isCurrentSeason}
          settings={settings}
          overrides={overrides}
          onBack={backToTracks}
        />
      )}

      <div style={{ ...styles.footer, marginTop: "1rem" }}>
        <span>Server: {settings.serverUrl}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
cd bridge-app && npx tsc --noEmit
cd ..
```

Expected: green.

- [ ] **Step 3: Stage**

```bash
git add bridge-app/src/screens/Picker.tsx
```

### Task 25: Version bump 0.4.4 → 0.5.0 + commit Phase 4

**Files:**
- Modify: `bridge-app/package.json`
- Modify: `bridge-app/src-tauri/tauri.conf.json`
- Modify: `bridge-app/src-tauri/Cargo.toml`

- [ ] **Step 1: Bump versions**

Edit each of the three files:
- `bridge-app/package.json`: change `"version": "0.4.4"` → `"version": "0.5.0"`
- `bridge-app/src-tauri/tauri.conf.json`: change `"version": "0.4.4"` → `"version": "0.5.0"`
- `bridge-app/src-tauri/Cargo.toml`: change `version = "0.4.4"` → `version = "0.5.0"`

- [ ] **Step 2: Verify**

```bash
grep -h "\"version\"" bridge-app/package.json bridge-app/src-tauri/tauri.conf.json
grep "^version" bridge-app/src-tauri/Cargo.toml
```

All three should show 0.5.0.

- [ ] **Step 3: Final type-check + build**

```bash
cd bridge-app && npx tsc --noEmit
cd ..
npm run lint
npm run build
```

All green.

- [ ] **Step 4: Commit Phase 4 in one shot**

```bash
git add bridge-app/package.json bridge-app/src-tauri/tauri.conf.json bridge-app/src-tauri/Cargo.toml
git commit -m "$(cat <<'EOF'
feat(round 36): bridge v0.5.0 — Picker rewrite to cards flow + season picker

Picker tab is now an in-tab state machine (weeks → tracks → track-detail)
with a season selector at the top. Track detail groups cars by class with
per-class-per-shop "Download all" chips. Bulk + Manage + Settings tabs
unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Checkpoint 4 verification (before Phase 5):**

- `cd bridge-app && npx tsc --noEmit` green.
- `npm run lint` green.
- `npm run build` green.
- `git log --oneline -5` shows the bridge commit.
- Optional Vite preview: `cd bridge-app && npm run dev` then open http://localhost:1420 — `fetch_picker` invoke calls will fail in browser preview (no Rust backend); error banner appears, that's expected.

---

## Phase 5 — Deploy + release (Checkpoint 5)

4 tasks. End state: web deployed with backfilled data; bridge v0.5.0 MSI on GitHub Releases; `/releases` page lists it.

### Task 26: Deploy web to Railway

**Files:**
- None (operational)

- [ ] **Step 1: Verify clean state**

```bash
git status
git log --oneline -10
```

Working tree clean. All 5 phase commits + Phase 1 seed commit present.

- [ ] **Step 2: Deploy**

```bash
railway up --detach
```

Note the deployment ID.

- [ ] **Step 3: Wait for SUCCESS**

```bash
railway status --json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('latestDeployment', {}).get('status', '?'))"
```

Poll every 30s until `SUCCESS` (~75s).

- [ ] **Step 4: Healthcheck**

```bash
URL=https://iracing-setup-comparison-production.up.railway.app
curl -s -o /dev/null -w "%{http_code} /\n" $URL/
curl -s -o /dev/null -w "%{http_code} /api/picker/seasons\n" $URL/api/picker/seasons
curl -s -o /dev/null -w "%{http_code} /api/picker/weeks\n" $URL/api/picker/weeks
curl -s -o /dev/null -w "%{http_code} /api/picker/tracks-by-class?weekNum=3&trackId=28\n" "$URL/api/picker/tracks-by-class?weekNum=3&trackId=28"
curl -s -o /dev/null -w "%{http_code} /api/ingest (GET, expect 405)\n" $URL/api/ingest
```

All expected: 200, 200, 200, 200, 405.

### Task 27: Seed production DB + backfill historical seasons

**Files:**
- None (operational)

- [ ] **Step 1: Seed production**

```bash
railway run npx tsx lib/seed.ts
```

Expected:
```
Seeded 4 seasons with 13 weeks each (52 weeks total).
Verification:
  shops: 5
  ...
  seasons: 4
  weeks: 52
```

- [ ] **Step 2: Verify seasons endpoint**

```bash
URL=https://iracing-setup-comparison-production.up.railway.app
curl -s $URL/api/picker/seasons | python3 -m json.tool
```

4 seasons; 26S2 has existing setupCount; 3 historical have setupCount=0.

- [ ] **Step 3: Backfill each historical season**

```bash
URL=https://iracing-setup-comparison-production.up.railway.app
SECRET=$(grep ^INGEST_SECRET .env | cut -d= -f2)

# 26S1
curl -X POST -H "Authorization: Bearer $SECRET" \
  "$URL/api/ingest?shop=all&year=2026&quarter=1" \
  --max-time 1200 | python3 -m json.tool

# 25S4
curl -X POST -H "Authorization: Bearer $SECRET" \
  "$URL/api/ingest?shop=all&year=2025&quarter=4" \
  --max-time 1200 | python3 -m json.tool

# 25S3
curl -X POST -H "Authorization: Bearer $SECRET" \
  "$URL/api/ingest?shop=all&year=2025&quarter=3" \
  --max-time 1200 | python3 -m json.tool
```

Each call ~5-10 min wall-clock.

- [ ] **Step 4: Re-verify seasons**

```bash
curl -s $URL/api/picker/seasons | python3 -m json.tool
```

All 4 entries should now have setupCount > 0.

- [ ] **Step 5: Spot-check bridge-facing endpoints**

```bash
curl -s "$URL/api/picker/weeks?year=2025&quarter=4" | python3 -m json.tool | head -20
curl -s "$URL/api/picker/tracks?weekNum=3&year=2025&quarter=4" | python3 -m json.tool | head -10
curl -s "$URL/api/picker/tracks-by-class?weekNum=3&trackId=28&year=2025&quarter=4" | python3 -m json.tool | head -30
```

All populated.

### Task 28: Tag bridge-v0.5.0 + GitHub Actions build

**Files:**
- None (operational)

- [ ] **Step 1: Tag and push**

```bash
git tag bridge-v0.5.0
git push origin bridge-v0.5.0
```

- [ ] **Step 2: Wait for the Actions run**

```bash
gh run list --workflow=bridge-build.yml --limit 3
```

Find the bridge-v0.5.0 run, then:

```bash
RUN_ID=<the run id from above>
gh run watch $RUN_ID
```

Expected: completed/success in ~14 min.

- [ ] **Step 3: Verify release assets**

```bash
gh release view bridge-v0.5.0
```

Expected:
- `iRacing.Setup.Bridge_0.5.0_x64_en-US.msi` (~3.2 MB)
- `latest.json` (~0.8 KB)

- [ ] **Step 4: Smoke proxy + manifest**

```bash
URL=https://iracing-setup-comparison-production.up.railway.app
curl -s $URL/api/latest-bridge | python3 -m json.tool
# Expected: { "version": "0.5.0", ... }

curl -s -I "$URL/api/bridge-asset/iRacing.Setup.Bridge_0.5.0_x64_en-US.msi" | head -5
# Expected: HTTP/2 200, content-type: application/octet-stream
```

If `/api/latest-bridge` still returns 0.4.4, wait 5 min for ISR cache to refresh.

### Task 29: Update `/releases` page fallback + final deploy

**Files:**
- Modify: `app/releases/page.tsx`

- [ ] **Step 1: Prepend v0.5.0 entry**

Open `app/releases/page.tsx`. Find the `FALLBACK_RELEASES` array. Use the exact `sizeBytes` value from `gh release view bridge-v0.5.0` (look for the MSI size). Prepend (at the top of the array):

```typescript
  {
    tag: "bridge-v0.5.0",
    name: "Bridge v0.5.0 — multi-season picker + cards-flow rewrite",
    publishedAt: "2026-05-19T00:00:00Z",
    body: "Picker tab is now a cards-everywhere flow (Season → Week → Track → Track-Detail-by-Class). Multi-season backfill landed (26S2, 26S1, 25S4, 25S3). HYMO chip dimmed on historical seasons.",
    assets: [
      {
        name: "iRacing.Setup.Bridge_0.5.0_x64_en-US.msi",
        downloadUrl: "https://github.com/ricardosilva1998/iracing-setup-comparison/releases/download/bridge-v0.5.0/iRacing.Setup.Bridge_0.5.0_x64_en-US.msi",
        sizeBytes: 3280896,
      },
    ],
  },
```

- [ ] **Step 2: Commit + push + deploy**

```bash
git add app/releases/page.tsx
git commit -m "$(cat <<'EOF'
docs(round 36): /releases lists bridge-v0.5.0

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
railway up --detach
```

Wait for SUCCESS.

- [ ] **Step 3: Verify**

```bash
URL=https://iracing-setup-comparison-production.up.railway.app
curl -s $URL/releases | grep -c "bridge-v0.5.0"
# Expected: at least 1
```

- [ ] **Step 4: In-app updater smoke (manual, user task)**

Open the existing v0.4.4 bridge install. Go to Settings → Check for Updates. The updater should detect v0.5.0 and offer install. After update:
1. Picker tab opens to season dropdown with 4 entries.
2. Default season (26S2) → 12-13 week cards.
3. Click a week → tracks (sorted by setupCount).
4. Click a track → class accordions collapsed.
5. Expand GT3 → shop chips visible; HYMO disabled on historical seasons.
6. Click "Download all (Grid-and-Go)" on a class → progress visible; setups land in `<iracingRoot>/<carFolder>/<season>/<track>/grid-and-go/`.

**Final checkpoint:**
- Production `/api/picker/seasons` returns 4 entries with non-zero counts.
- `/api/latest-bridge` returns `"version": "0.5.0"`.
- `/releases` page shows v0.5.0 at top.
- Manual bridge smoke confirms the cards-flow UI works.

---

## Open follow-ups (out of scope this plan)

- Web app multi-season UI (web routes still render only the active season).
- HYMO historical scraping if a workaround surfaces.
- Bulk Download tab gaining a season selector.
- Active-season rollover automation (today operators manually flip `isActive` in `lib/seed.ts` quarterly).

## Total

**29 tasks across 5 phases.** Each phase ends in a verifiable commit + healthcheck. Expect ~1-2 work sessions per phase.
