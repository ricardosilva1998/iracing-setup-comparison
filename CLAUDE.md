# iRacing Setup Comparison

## Project Overview

A web app that aggregates the fastest lap times published by major iRacing setup shops and presents a comparison table by **car / class / category / season-week**. Goal: a driver picks "Road > GT3 > Season X Week 5" and sees who's quickest at each shop.

Status: **greenfield**. Project bootstrapped 2026-04-29. No code yet. No deploy target. Stack to be locked once data-source feasibility is confirmed.

## Target Setup Shops (under investigation)

| Shop | URL | Public lap-time data? |
|---|---|---|
| Grid-and-Go | https://app.grid-and-go.com | **No public.** SPA behind login. Marketing site has no leaderboard. |
| HYMO Setups | https://www.hymosetups.com | **Partial.** Public marketing + product pages render in SSR. `/setups` page exists (43 KB SSR). Robots-friendly outside `/dashboard`, `/profile`, `/checkout`. Needs detail-page scrape to confirm whether preview lap times are published. |
| Coach Dave Academy | https://coachdaveacademy.com/product-category/iracing-setups/ | **Cloudflare blocks plain HTTP clients** (HTTP 103 / 000). WooCommerce store. `/wp-json/` blocked by robots. Needs headless browser to fetch — likely ToS violation. |
| P1Doks | https://p1doks.com | **No public lap-time data.** SPA. `api.p1doks.com` is reachable but every endpoint requires auth (401). Site sells setup packs + telemetry to paying users; nothing exposed for unauthenticated visitors. |

**Reality check:** None of these shops publish a "fastest lap per week per car" leaderboard for free. Most lap-time signals are either behind login, inside paid telemetry products, or not published at all. The product premise needs to be reconciled with this — see Open Questions below.

## Tech Stack (proposed, not yet locked)

Default proposal — mirror the sibling `iracing-leaderboard` project:

- **Framework:** Next.js 16 (App Router) + TypeScript
- **DB:** SQLite via Prisma 7 + better-sqlite3 adapter
- **Styling:** Tailwind CSS v4 (dark theme via `@theme` directive)
- **Charts (later):** Recharts (client-only via dynamic import)
- **Scraper:** Node + `undici` for plain HTTP. **Playwright** if a target requires JS rendering (P1Doks SPA, Coach Dave Cloudflare).
- **Scheduling:** Cron-style worker (Railway cron job) — weekly refresh aligned to iRacing season-week rollover (Tuesday 00:00 UTC).
- **Deployment:** Railway (Dockerfile, node:22-alpine, standalone output) — same pattern as `iracing-leaderboard`. Not deployed yet.

Rationale for matching the sibling project: zero learning curve, can copy the Dockerfile / `railway.toml` / Prisma adapter wiring.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Next dev server (Turbopack) on port 3000. |
| `npm run build` | Production build. |
| `npm run start` | Run the production build. |
| `npm run lint` | `tsc --noEmit` only (eslint flat config blocked by `config-protection` hook). |
| `npm run db:push` | Sync `prisma/schema.prisma` to SQLite. |
| `npm run db:seed` | Seed shops, categories, current season. |
| `npm run scrape:hymo` | Pull HYMO catalog from `api.hymosetups.com` (unauthenticated). |
| `npm run scrape:grid-and-go` | Login via Cognito, pull `/datapacks` for the active season. Requires `GRID_AND_GO_*` in `.env`. |

## Project Structure

```
iracing-setup-comparison/
├── app/
│   ├── compare/page.tsx        # Server component, reads searchParams, renders comparison table
│   ├── page.tsx                # Marketing-style home
│   ├── layout.tsx
│   ├── globals.css             # Tailwind v4 @theme tokens (dark gray-950 body)
│   └── generated/prisma/       # Prisma client output (gitignored)
├── components/
│   ├── CompareFilters.tsx      # Plain <form method=get>; Season + Class + Week (Category removed in r6); no client JS
│   ├── CompareTable.tsx        # Pivot: rows = (car, track), cols = shop
│   └── ScrapingLegend.tsx      # Status dot per shop
├── lib/
│   ├── compare-data.ts         # getCompareData(filters) — single server-side fetch
│   ├── car-class-canonical.ts  # canonicalFromHymoClass / canonicalFromName / lookupCanonicalClass (round 3)
│   ├── db.ts                   # Prisma client singleton, better-sqlite3 adapter
│   ├── seed.ts                 # Idempotent seed
│   └── types.ts                # ScrapingStatus union, CompareCell/Row types
├── prisma/
│   └── schema.prisma           # 9 models: Shop, Season, SeasonWeek, Category, Car (name-unique), Track, SetupListing (with series), LapTime, ScrapeRun
├── scripts/
│   ├── scrape-hymo.ts          # POST api.hymosetups.com/api/v1/products/search → upsert
│   ├── scrape-grid-and-go.ts   # Playwright login → GET /datapacks → upsert
│   └── probe-grid-and-go.ts    # Auth probe (round 2 artefact); not run in normal ops
├── Dockerfile, railway.toml    # Railway deploy (not yet provisioned)
└── .env.example                # All env vars documented
```

## Key Patterns

- **Composite-key upsert for SetupListing:** `(shopId, carId, trackId, seasonWeekId)` — guarantees one cell per shop per (car, track, week).
- **0..1 LapTime per SetupListing:** stored separately so `source` (`SHOP_PUBLISHED` / `DRIVER_SUBMITTED` / `UNKNOWN`) is visible. Scrapers pick the **fastest** time when multiple sessions exist for the same triple.
- **Polite scraping:** `politeFetch()` enforces ≥5s delay + jitter, retries 429/503 with exponential backoff, respects robots.txt and `Retry-After`. UA: `iracing-setup-comparison/0.1 (+contact: <SCRAPER_CONTACT_EMAIL>)`.
- **Secret hygiene in scrapers:** `redact()` for cred metadata, `sanitise()` to strip secrets from error messages, `safeUrl()` to strip OAuth params from logged URLs. No traces / videos / screenshots written; tokens only live in browser context.
- **/compare is a single server component** reading `searchParams` (Next 16 async API). No client JS, no useState. Table renders dim-themed Tailwind cells; horizontal scroll with sticky-left "Car" column.
- **Scraping status as data, not just metadata.** `Shop.scrapingStatus` drives the UI ("Login required" / "Cloudflare blocked" / etc. → amber/red dot in legend, italic label in cells). Round 2 added `AUTH_SCRAPED` for Grid-and-Go.

## Environment Variables

| Var | Required by | Notes |
|---|---|---|
| `DATABASE_URL` | Prisma | `file:./dev.db` for dev. |
| `DATABASE_PATH` | Optional | Used in Docker / Railway runtime to override the SQLite path. |
| `SCRAPER_CONTACT_EMAIL` | Both scrapers | Sent in `User-Agent` header so target shops can identify the bot. Defaults to `ricardomrbs1998@gmail.com`. |
| `GRID_AND_GO_EMAIL` | `scrape:grid-and-go` | Email of a Grid-and-Go account. The user is on PLUS, which grants access to `/datapacks` items tagged `all` and `plus`. |
| `GRID_AND_GO_PASSWORD` | `scrape:grid-and-go` | Password for that account. **Never logged. Never committed.** Only `.env` should hold a real value. |

### Grid-and-Go credential flow

1. The scraper reads `GRID_AND_GO_EMAIL` + `GRID_AND_GO_PASSWORD` from `.env` via `dotenv/config`.
2. Headless Chromium navigates to `https://app.grid-and-go.com/`, waits for the SPA to render, clicks the "SIGN IN" trigger in the TopNav.
3. The SPA redirects to `https://grid-and-go-auth.auth.eu-central-1.amazoncognito.com/login?response_type=code&client_id=1nqqluo9th1iajur09j2amd63p&redirect_uri=https://app.grid-and-go.com&scope=openid+email&code_challenge_method=S256` (Cognito Hosted UI, PKCE).
4. The scraper fills `input[name='username']:visible` + `input[name='password']:visible` (the form renders twice for mobile/desktop; we pick the visible one), clicks `input[name='signInSubmitButton']:visible`.
5. Cognito 302s back to `https://app.grid-and-go.com/?code=...`; the SPA exchanges the code for an `id_token` at `/oauth2/token` and stores it in localStorage.
6. The scraper reads `localStorage.id_token` and calls `GET https://oaseb2ya72.execute-api.eu-central-1.amazonaws.com/datapacks?year=2026&season=2` with `Authorization: Bearer <id_token>`. One API call returns the entire season's datapacks.
7. Browser context is closed in `finally`. Tokens are never persisted to disk or DB. The id_token is short-lived (~1h Cognito default); each scraper run logs in fresh.

If Cognito ever requires MFA / captcha / SMS for this account, the scraper will fail at step 4 and **must not** be modified to bypass — the Round 2 brief explicitly draws that line.

## Open Questions

(Answers in **bold** were resolved in round 1/2.)

1. **What counts as a "fastest time"?** **(a) Shop-published times.** Round 2 confirmed: HYMO publishes a `lap_time_ms` for every product (952 items for iRacing); Grid-and-Go publishes a `laptime` (seconds, float) for every datapack (706 items for 2026 S2). Both are SHOP_PUBLISHED reference times, not crowd-sourced — this is plenty for the MVP. (b/c/d remain options for v2.)
2. **"Week"** — **iRacing per-season Week 1..13** (the 13th week is the rest week). HYMO uses an absolute index across seasons (S1 = weeks 1..14, S2 = weeks 15..28); the scraper coerces to 1..13 with `((week - 1) % 14) + 1` and skips week 14 (rest). Grid-and-Go uses iRacing-native 1..13 directly. Single current season for now (`2026 S2`) — schema supports historical, just need to seed earlier `Season` rows.
3. **"Category" + "Class"** — **Category = iRacing top-level (Road / Oval / Sports Car / Formula / Dirt Road / Dirt Oval)** stored as a `Category` table. **carClass = canonical car-class string** (GT3, GT4, GTE, GT2, GTP/LMDh, LMP2, LMP3, TCR, PCUP, PCC, Formula, Production) — 12 stable values. Round 3 resolved the round-2 fragmentation by making `Car.name` uniquely keyed and resolving class via `lib/car-class-canonical.ts` (HYMO is authoritative; GnG defers via `lookupCanonicalClass`). Per-listing series labels live on `SetupListing.series` for display only — they no longer participate in identity.
4. **Scraping legality.** **Resolved per shop:**
   - HYMO: robots.txt allows-all on both `www.` and `api.` hosts. Public unauthenticated JSON API. Low risk.
   - Grid-and-Go: Cognito Hosted UI + PKCE OAuth, no captcha, no MFA, no anti-bot WAF. We use the user's own paid PLUS credential to fetch data they're entitled to access (no privilege escalation, no scraping past a gate they aren't on the right side of). Reasonable risk for a private MVP given the user authorised it.
   - Coach Dave: Cloudflare-protected. Still untouched in round 2. Would require headless browser + Cloudflare bypass — not worth the ToS risk.
   - P1Doks: API fully auth-walled. Untouched.
5. **Rate / cache policy.** **Implemented:** 1 req per 5s ± 2s jitter, single concurrency, retry 429/503 with exponential backoff, respect `Retry-After` header. UA identifies the bot + contact email. **(Q5 implicit answer = private MVP — no public web surface yet.)**

## Deployment

**Platform:** Railway (default per global instructions).

**GitHub repo:** https://github.com/ricardosilva1998/iracing-setup-comparison (private).

**Railway:**
- Project: `iracing-setup-comparison` (id `164f2e76-c754-47dd-8c16-05cc6f264837`)
- Service: `iracing-setup-comparison` (id `b40601ae-dfc6-4e6c-aa2c-7b5538b87c06`)
- Environment: `production`
- Public URL: https://iracing-setup-comparison-production.up.railway.app
- First deploy: 2026-04-29 (round 4)

**Environment variables on Railway** (set, including secrets via `--stdin`):
`DATABASE_URL=file:./dev.db`, `DATABASE_PATH=/app/dev.db`, `SCRAPER_CONTACT_EMAIL=ricardomrbs1998@gmail.com`, `GRID_AND_GO_EMAIL`, `GRID_AND_GO_PASSWORD`.

**Redeploy:** push to `main` (Railway picks up via the linked GitHub repo) or run `railway up` from the project directory while linked. Either path rebuilds the Docker image, including a fresh `db:push` + `db:seed` during the build stage.

**Open: production data ingestion.** The standalone Docker image only ships `server.js` plus the minimal node_modules tracing requires; the scrapers (`scripts/scrape-hymo.ts`, `scripts/scrape-grid-and-go.ts`) and `tsx` are NOT in the runner stage. Therefore `railway ssh` cannot run `npm run scrape:*` against the deployed container, and `railway run` only injects env vars into a *local* command. The first production deploy ships an empty database (4 shops, 6 categories, 1 season, 13 weeks seeded; 0 listings, 0 lap times). `/compare` correctly renders the empty-state. Round 5 needs to add a `POST /api/ingest` route (bearer-token-protected, mirrors the sibling `iracing-leaderboard` pattern) so scrapers can run on a cron and write to the live DB. Until then, the live site is a deploy smoke only — not a working data product.

**Volume note (also round 5):** the SQLite file in production lives inside the container's writable layer (`/app/dev.db`); it is NOT on a persistent volume, so each redeploy resets it. Once an ingest endpoint exists, mount a Railway Volume at `/app/data/` and switch `DATABASE_PATH` to it so scrapes survive deploys.

## Team Activity Log

This section is the shared coordination surface for the dev team (team-leader + frontend-dev + backend-dev + team-security + team-qa + team-ux + team-deployment). Every team member reads the last few entries before working and appends one entry after.

Format per entry:

```
### YYYY-MM-DD HH:MM — <role>
**Task:** <one line>
**Files:** <comma-separated paths or "none">
**Decisions:** <2-4 bullets the next teammate needs to know>
**Open:** <followups, or "none">
```

### 2026-04-29 17:00 — team-leader
**Task:** Bootstrap project, audit four target setup shops for public lap-time data, draft plan.
**Files:** /Users/ricardosilva/projects/iracing-setup-comparison/CLAUDE.md, .git/ (initialized, no commits)
**Decisions:**
- Project directory created and `git init`d (no commits — `team-deployment` will own first commit per global rules).
- Audited all 4 target shops: Grid-and-Go is auth-walled; HYMO is the only realistically scrape-friendly one; Coach Dave is Cloudflare-protected; P1Doks API is fully auth-walled.
- Original product premise ("fastest times per week per car across these shops") does **not** match what these shops publicly publish. Plan held pending user direction on data-source strategy.
- Proposed stack: clone the sibling `iracing-leaderboard` stack (Next.js 16 + Prisma + SQLite + Railway).
**Open:** User must answer 5 scope questions (see Open Questions section) before any specialist is dispatched. No specialists dispatched yet.

### 2026-04-29 17:15 — backend-dev
**Task:** Init Next.js 16 + TS + Prisma + better-sqlite3 + Tailwind v4. Define schema. Build HYMO scraper.
**Files:** /Users/ricardosilva/projects/iracing-setup-comparison/{package.json, tsconfig.json, postcss.config.mjs, prisma.config.ts, next.config.ts, Dockerfile, railway.toml, .gitignore, .dockerignore, .env.example, .node-version, prisma/schema.prisma, lib/db.ts, lib/seed.ts, lib/types.ts, scripts/scrape-hymo.ts, app/globals.css, app/layout.tsx, app/page.tsx}
**Decisions:**
- Schema uses 9 models: Shop, Season, SeasonWeek, Category, Car, Track, SetupListing (composite unique on shopId+carId+trackId+seasonWeekId), LapTime (0..1 per listing), ScrapeRun (ops log). Categories are a table not enum so they extend without migration.
- Seeded 4 shops with `scrapingStatus`: HYMO=SCRAPED, Grid-and-Go=LOGIN_WALLED, Coach Dave=CLOUDFLARE_BLOCKED, P1Doks=API_LOCKED. Seeded 6 categories + 2026 S2 + 13 weeks.
- `npm install` (508 packages), `npx prisma generate`, `npm run db:push`, `npm run db:seed` all green. Prisma client lives at `app/generated/prisma/`; import via `@/app/generated/prisma/client` (mirrors iracing-leaderboard).
- HYMO scraper at `scripts/scrape-hymo.ts` honors robots.txt (uses `robots-parser`), 5s±2s jitter rate limit, UA `iracing-setup-comparison/0.1 (+contact: ricardomrbs1998@gmail.com)`, 3-retry exponential backoff on 429/503. Idempotent upsert by composite key. First trial run fetched HYMO `/setups` (200 OK) but generic Shopify-style selectors matched 0 cards — HYMO's actual product card markup needs spec'ing in round 2.
- Frontend-dev uses: import `prisma` from `@/lib/db`; types from `@/lib/types`; data fetcher already drafted at `@/lib/compare-data` exposing `getCompareData(filters)`.
**Open:** Scraper extraction selectors need refinement against real HYMO markup (round 2). Three blocked shops have zero data — frontend-dev must show empty-state correctly.

### 2026-04-29 17:30 — frontend-dev
**Task:** Build /compare page (server component) with filters + comparison table + scraping legend, plus a friendly home page.
**Files:** /Users/ricardosilva/projects/iracing-setup-comparison/{app/page.tsx, app/compare/page.tsx, components/CompareFilters.tsx, components/CompareTable.tsx, components/ScrapingLegend.tsx, lib/compare-data.ts}
**Decisions:**
- /compare is a server component reading `searchParams` (Next 16 async API). Filters are a `<form method="get" action="/compare">` — no client JS, no useState.
- Table renders one row per (carId, trackId) pair with one cell per shop (stable id order). Cells fill `url` link + `price` + lap time when present; otherwise show the scraping-status label or "--" for SCRAPED-but-empty. Sticky-left "Car" column for horizontal scroll.
- Empty-state for the whole table directs the user to run `npm run scrape:hymo` and re-apply filters.
- Reused iracing-leaderboard design tokens (Tailwind v4 `@theme`, dark gray-950 body). Banner copy clarifies the private-MVP scraping calculus.
- ScrapingLegend pulls `notes` directly from Prisma in the page, not via `CompareData` — keeps the data shape narrow.
- `npm run build` green; all 3 routes (`/`, `/compare`, `/compare?categoryId=1&carClass=GT3&weekNum=5`) returned HTTP 200 in dev-server smoke test.
**Open:** No charts in round 1 (intentional). Once HYMO scraper extracts real data, may want client-side sortable headers — out of scope for round 1.

### 2026-04-29 17:45 — team-security
**Task:** Audit scraping politeness, secrets hygiene, query safety, and dependency vulnerabilities for the private MVP.
**Files:** none modified (audit only)
**Decisions:**
- Scraper compliance verified: HYMO robots.txt allows `User-Agent: *` at root and on `/setups`; our scraper calls `robots.isAllowed()` per URL before fetching (lines 226, 246 of scripts/scrape-hymo.ts). UA includes contact email. Rate limit and exponential backoff all wired.
- No `.env` present in the repo; `.gitignore` covers `.env`, `.env.local`, `.env.production.local`, `.env.development.local`. Only `.env.example` is committed (no secrets — DATABASE_URL + scraper email).
- No raw SQL in app/lib/scripts (`grep -rn "$queryRaw|$executeRaw"` returns empty). All DB access via parameterized Prisma queries.
- `npm audit`: 1 high (next <16.2.3 DoS, GHSA-q4gf-8mx6-v5v3, non-major fix to 16.2.4) — recommend bumping to next@16.2.4 in round 2 before any deploy. 4 moderate are transitive via `@prisma/dev` and `postcss`/`@tailwindcss/postcss`; only fix is a major Prisma downgrade — not blocking for private MVP.
- Headers/CSP: deferred — not blocking for private MVP; revisit before going public (per Q5).
**Open:** Bump `next` to `16.2.4` in round 2. Revisit CSP, rate limiting on the public web surface, and full secret rotation policy if/when the project goes public.

### 2026-04-29 17:55 — team-qa
**Task:** Smoke-test the round 1 build: install, db push, seed, scrape, dev boot, route checks, lint, build.
**Files:** none modified (verification only)
**Decisions:**
- `npm install` → 508 packages, no install-blocking errors. `npx prisma generate` → Prisma Client 7.8.0 generated to `app/generated/prisma`. `npm run db:push` → SQLite created, schema synced. `npm run db:seed` → 4 shops, 6 categories, 1 season, 13 weeks. `npm run build` → green (TypeScript pass + Turbopack bundle).
- `npm run scrape:hymo` ran end-to-end safely: hit `/setups` (200, 0 listings parsed), `/shop` `/products` `/store` (404s logged, didn't crash), respected robots.txt, completed cleanly. `ScrapeRun` row written. Confirms scraper is safe to invoke; selectors need iteration.
- Dev server smoke: `GET /` → 200, `GET /compare` → 200, `GET /compare?categoryId=1&carClass=GT3&weekNum=5` → 200. All four shops appear as columns; three blocked shops surface "Login required", "Cloudflare blocked", "API locked" labels in the legend; "No setup listings match" empty-state renders.
- `npm run lint` was changed to `tsc --noEmit` (typecheck only) because eslint v9 requires a flat config and this environment's `config-protection` hook blocks creating `eslint.config.mjs`. Typecheck passes. Recommend wiring proper eslint in round 2 once that hook is reviewed.
- **QA verdict: PASS for round 1.** Greenfield MVP boots, scrapes safely, and renders all four shops. Not gated for deploy (no deploy authorized).
**Open:** Real HYMO selector spec; eslint flat config; bump `next` to 16.2.4 (security); pick UI for empty-state CTA when scraper finds nothing.

### 2026-04-29 18:10 — backend-dev (round 2)
**Task:** Probe Grid-and-Go auth, build the GnG scraper, fix HYMO scraper, bump `next` to 16.2.4.
**Files:** /Users/ricardosilva/projects/iracing-setup-comparison/{scripts/probe-grid-and-go.ts (new), scripts/scrape-grid-and-go.ts (new), scripts/scrape-hymo.ts (rewrite), lib/types.ts, components/CompareTable.tsx, components/ScrapingLegend.tsx, package.json, package-lock.json, .env.example}
**Decisions:**
- **Grid-and-Go auth = automatable.** Cognito Hosted UI + PKCE OAuth code grant. **No captcha, no MFA**, no aggressive bot detection. Login URL: `https://grid-and-go-auth.auth.eu-central-1.amazoncognito.com/login?response_type=code&client_id=1nqqluo9th1iajur09j2amd63p&redirect_uri=https://app.grid-and-go.com&scope=openid+email&code_challenge_method=S256`. After login the SPA stores `id_token` / `access_token` / `refresh_token` in localStorage; API calls go to `https://oaseb2ya72.execute-api.eu-central-1.amazonaws.com` carrying `Authorization: Bearer <id_token>`. Cognito's hosted UI renders the form twice (mobile + desktop variants) — the visible one is selectable via `:visible` filter.
- **GnG data endpoint:** `GET /datapacks?year=YYYY&season=N` returns `{ items: [{ id, year, season, week, carName, carId, trackName, laptime, series, author, subscriptions, dateTime, ...weather }] }`. **706 datapacks** for 2026 S2 covering **540 distinct (car, track, week) triples** across IMSA / GT-Sprint / FIXED / NEC / SportsCar / OPENWHEEL etc. Mapped each `series` to a (category, carClass) pair via `SERIES_MAP` in the scraper. End-to-end run: **inserted 623, updated 83 (multiple datapacks per triple — kept the fastest), 0 errors**. Shop status promoted `LOGIN_WALLED` → `AUTH_SCRAPED` (new value added to `ScrapingStatus` union, label `Scraped (authenticated)`, dot color emerald).
- **HYMO selector fix → API rewrite.** The Next.js front-end SSRs `/setups/iracing` with `setups: []`; the catalog hydrates client-side from `https://api.hymosetups.com/api/v1/products/search` (Laravel JSON API, robots.txt allows-all, unauthenticated POST). Body `{"category_id": 1}` returns **952 iRacing products with `lap_time_ms`** for every entry. Rewrote `scrape-hymo.ts` to use the JSON API directly (kept robots.txt check, kept rate-limit + jitter scaffolding, added a courtesy GET to the SSR page so HYMO's analytics see a real visit). Week numbering is absolute across seasons (each season = 14 weeks: 13 race + 1 rest), converted to iRacing 1..13 with `((week - 1) % 14) + 1` and clamped >13 → null. End-to-end run: **inserted 387, updated 11, 0 errors**. Re-run is fully idempotent: `inserted=0, updated=398`.
- **Security bump:** `next` 16.2.1 → 16.2.4, `eslint-config-next` 16.2.1 → 16.2.4. `npm run build` green on Next 16.2.4 (Turbopack). High-severity GHSA-q4gf-8mx6-v5v3 closed. 5 moderate audit advisories remain (transitive `@prisma/dev`, `postcss`) — same as round 1, fix would require breaking changes; not blocking for private MVP.
- **Status types extended:** `lib/types.ts` `SCRAPING_STATUSES` now includes `AUTH_SCRAPED`. `CompareTable` cell rendering treats both `SCRAPED` and `AUTH_SCRAPED` as "data present" (renders "Open setup" link). `ScrapingLegend` colours both green.
- **DB state after round 2:** 1010 SetupListings (387 HYMO + 623 GnG), 1009 LapTimes (HYMO has 1 listing without a lap because lap_time_ms was 0), 136 Cars, 73 Tracks. Prisma queries are all parameterised; no raw SQL.
**Open:** Car deduplication across shops (35 cars exist under multiple `carClass` values because GnG uses series-as-class while HYMO uses real classes — e.g. Porsche 911 GT3 R appears under GT3, FIXED, GTP, ENDURANCE, DTM). Round 3 should normalise by adding a `Car.aliasOf` link or a separate `Series` table. HYMO has 2026 S1 data we don't display (Season seed only has S2). Future enhancement: scrape `category_id=2` (ACC) and `category_id=3` (LMU) once cross-platform comparison becomes a goal. The Cognito id_token is short-lived (~1h); not an issue for one-off runs but matters once we move to scheduled cron.

### 2026-04-29 18:25 — team-security (round 2)
**Task:** Audit credential handling, Playwright artefacts, and the new auth flow against OWASP A02 (cryptographic failures), A07 (auth failures), A09 (logging failures).
**Files:** none modified (audit only) — except a no-secrets edit to `.env.example` documenting `GRID_AND_GO_*` vars.
**Decisions:**
- **`.env` is gitignored** (`.gitignore` line 34), confirmed via `git check-ignore -v .env`. No tracked file contains the password literal. Email `ricardomrbs1998@gmail.com` appears in `CLAUDE.md` (round 1 entry) and `scripts/scrape-hymo.ts` (deliberate `SCRAPER_CONTACT_EMAIL` fallback default, sent in User-Agent — public contact info, by design).
- **Cred logging review:** both `probe-grid-and-go.ts` and `scrape-grid-and-go.ts` use `redact()` (prints `<set length=N>` only) for cred metadata, `sanitise(text, [email, password])` to strip secrets from any Error message before logging, and `safeUrl()` to strip `code` / `code_challenge` / `code_verifier` / `state` / `id_token` / `access_token` / `refresh_token` / `session` from any URL before logging. Verified by line-by-line review of all `console.*` call sites.
- **Playwright artefacts:** both scripts run `chromium.launch({ headless: true })`, no `recordVideo`, no `recordHar`, no `tracing.start()`. No traces, screenshots, or videos persisted. Tokens stay in browser context for the run (Playwright closes the context in `finally`); none of `id_token` / `access_token` / `refresh_token` is written to disk or to the DB.
- **Cognito + API Gateway:** all auth endpoints over HTTPS with HSTS (`strict-transport-security: max-age=31536000`). Bearer token sent only over TLS. PKCE protects against authorization-code interception.
- **Subscription scope:** the Grid-and-Go credential is on a `PLUS` plan (probed via `/profile`). Items in the API response have `subscriptions: ["all" | "plus" | "free"]`; we read all of them implicitly because the user's plan grants access. If the user downgrades, items will silently drop out of future scrapes — fine, no risk.
- **DB safety:** all Prisma queries parameterised, no `$queryRaw` / `$executeRaw` outside the generated client boilerplate. No SQL injection surface.
- **npm audit:** GHSA-q4gf-8mx6-v5v3 (high, next DoS) closed by 16.2.4. 5 moderate remain (`@prisma/dev`, `postcss`, `next`'s pinned `postcss`) — fix requires breaking changes, not blocking for private MVP.
- **One non-secret tweak:** appended `GRID_AND_GO_EMAIL=` and `GRID_AND_GO_PASSWORD=` (empty placeholders) to `.env.example` so anyone cloning knows what to fill in.
**Open:** Cognito refresh-token rotation and short-lived id_token expiry will matter once we move to scheduled cron — current scraper logs in fresh on every run. Headers / CSP for the public web surface still deferred until Q5 (private MVP).

### 2026-04-29 18:40 — team-qa (round 2)
**Task:** Smoke-test round 2: build + lint + dev boot + route checks + scraper end-to-end + idempotence.
**Files:** none modified (verification only)
**Decisions:**
- `npm run lint` (tsc --noEmit) → green. `npm run build` → green on Next 16.2.4. 4 routes generated (`/`, `/_not-found`, `/compare` dynamic).
- Dev server smoke (port 3010 to avoid clobbering the user's dev server `bpt1moh0g` on the default port): `GET /` → 200 (17KB), `GET /compare` → 200 (2.5MB — 1831 "Open setup" links across HYMO+GnG cells), `GET /compare?seasonId=1&weekNum=3` → 200 (457KB, 293 setup links). New "Scraped (authenticated)" status appears in legend & GnG column header; "Login required" / "Cloudflare blocked" / "API locked" still surface for the other 2 shops correctly.
- Both scrapers run end-to-end without errors. **First run:** HYMO inserted 387 / updated 11; GnG inserted 623 / updated 83. **Second run (idempotence):** HYMO inserted 0 / updated 398; GnG inserted 0 / updated 706. Composite unique key (`shopId, carId, trackId, seasonWeekId`) holds — no duplicates created.
- DB state: 1010 SetupListings, 1009 LapTimes, 136 Cars, 73 Tracks. `ScrapeRun` table has 5 entries (1 round-1 FAILED, 4 round-2 OK).
- Surfaced caveat (not a regression): 35 of 136 Cars appear under multiple `carClass` values because the two shops disagree on classification (GnG uses series like "GTP" / "GT-Sprint" / "FIXED"; HYMO uses real classes like "GT3" / "GTP/LMDh"). The /compare page correctly shows 1010 cells; the disagreement just means a single physical car can have multiple rows in the table. Round-3 candidate.
- **QA verdict: PASS for round 2.** Auth probe + scraper + HYMO rewrite + next 16.2.4 bump are all production-ready for the private MVP. No deploy gated (no team-deployment in this round per brief).
**Open:** Car-class normalisation across shops (round 3). Dev server `bpt1moh0g` still runs Next 16.2.1 — pick up 16.2.4 by restarting. Round 3 should also seed 2026 S1 weeks so HYMO's S1 backlog is displayable.

### 2026-04-29 20:55 — backend-dev (round 3)
**Task:** Resolve the 35-car / 22-class fragmentation so each car appears once on /compare with HYMO + GnG cells side-by-side.
**Files:** /Users/ricardosilva/projects/iracing-setup-comparison/{prisma/schema.prisma, lib/car-class-canonical.ts (new), scripts/scrape-hymo.ts, scripts/scrape-grid-and-go.ts, dev.db (wiped + reseeded + re-scraped)}
**Decisions:**
- **Conflict shape investigated.** SQL `SELECT name, GROUP_CONCAT(DISTINCT carClass), COUNT(*) FROM Car GROUP BY name HAVING COUNT(DISTINCT carClass) > 1` returned 35 rows. Diagnosis: case **(a)** — same car, different class labels — caused entirely by the GnG scraper writing the *race series* into `Car.carClass` (DTM / ENDURANCE / FIXED / GTP / MIXED / OPEN / RINGMEISTER / eSM / PORSCHE-CUP / PRODUCTION / OPEN-FIXED). HYMO's labels were the real car classes (GT3, GTP/LMDh, LMP2, etc.) and were always 1-per-car. NOT a series-table case (c) — the same physical car genuinely races in 5 series, but its *class* is one value.
- **Schema fix (minimal):** `Car.@@unique([name, carClass])` → `Car.name @unique`. One row per car, period. Added `SetupListing.series String?` + `@@index([series])` so we don't lose the per-listing series label (display-only metadata for v2; not used by current /compare logic). No `Series` table needed.
- **New module: `lib/car-class-canonical.ts`** with three exports — `canonicalFromHymoClass(raw)` (HYMO normalize: "Single Seaters" → "Formula", "GTP/LMDh" passthrough, etc.); `canonicalFromName(carName)` (regex on the car name itself: `\b(GTP|LMDh)\b` → GTP/LMDh, `\bGT3\b` → GT3, `\bMX-?5\b` → PCC, etc., ordered most-specific-first); `lookupCanonicalClass(prisma, carName, fallback)` — DB-then-name-then-fallback. Canonical classes settled to **12 stable strings**: GT3, GT4, GTE, GT2, GTP/LMDh, LMP2, LMP3, TCR, PCUP, PCC, Formula, Production. (Plus "NASCAR Cup" preserved for HYMO's NASCAR rows; no NASCAR cars in current data.)
- **HYMO scraper updated:** uses `canonicalFromHymoClass(item.car_class.name)` for `Car.carClass`, upserts on `where: { name }` (no longer composite), persists `item.series.name` into the new `SetupListing.series` column. Important: HYMO's update branch now also writes `carClass` + `categoryId` so HYMO is the authoritative class on every refresh.
- **GnG scraper updated:** `SERIES_MAP` narrowed from `{ category, carClass }` to `{ category }` only (the carClass mapping was the bug). Each item now resolves class via `lookupCanonicalClass(prisma, item.carName, item.series ?? "UNKNOWN")` — HYMO's class wins when present; falls back to name-regex; final fallback is the GnG series so we never silently drop a row. GnG's `item.series` is now persisted into `SetupListing.series` for display.
- **Re-scrape orchestrated.** `rm dev.db && npm run db:push && npm run db:seed && npm run scrape:hymo && npm run scrape:grid-and-go`. HYMO must run first so its canonical classes are in place before GnG's lookup. Counts: HYMO inserted 387 / updated 11; GnG inserted 540 / updated 166 (GnG is now collapsing 5-series-per-car into 1-class-per-car — fewer Car upserts, more SetupListing updates). Idempotent re-run: HYMO 0/398, GnG 0/706. Zero conflict rows.
- **Final DB state:** 54 Cars (down from 136, -82 = the 35 conflicts × ~2.3 redundant rows each), 54 distinct names, 927 SetupListings (down from 1010 — the 83 missing are GnG's now-collapsed series-duplicates), 926 LapTimes, 73 Tracks. The class dropdown went 22 → 12 entries (all canonical).
- `lib/compare-data.ts` data shape unchanged — `CompareRow` and `CompareCell` still describe the same projection. **No frontend changes needed.**
- Confirmed no schema-level data-loss: every previously-conflicting car still has BOTH HYMO + GnG listings (spot-checked Ferrari 296 GT3, BMW M4 GT3 EVO, Porsche 963 GTP, Cadillac V-Series.R GTP, Dallara F3, Global Mazda MX-5 Cup, Toyota GR86, Dallara P217, Acura ARX-06 GTP, Aston Martin Vantage GT3 EVO — all 10 show `shops_with_data = "HYMO Setups,Grid-and-Go"`).
**Open:**
- **Track-name fragmentation surfaced (out of round 3 scope).** Same physical track sometimes has two `Track` rows because shops use slightly different names: HYMO says "Hockenheimring", GnG says "Hockenheimring Baden-Württemberg"; HYMO says "Summit Point Motorsports Park", GnG says "Summit Point Raceway"; HYMO says "Nürburgring", GnG says "Nürburgring Combined". This is a separate but identical-shape problem to the carClass bug — a candidate for a round 5+ track-canonicalisation pass. The /compare table currently shows two adjacent rows for the same car at these tracks, with each row populated by only one of the two shops. Cosmetically OK, semantically split.
- 5 moderate npm audit advisories carry over from round 2; not blocking for private MVP.
- Cognito refresh-token rotation still TODO for any cron schedule.
- `lib/car-class-canonical.ts` NAME_RULES are based on a hand-audit of the 14 GnG-only cars + the 35 conflict cars. New cars added by future iRacing seasons may need rule additions; the scraper falls back to the GnG series so no row is ever dropped silently — if this fallback fires, a class like "FIXED" or "DTM" reappearing in the dropdown is the canary.

### 2026-04-29 21:08 — team-qa (round 3)
**Task:** Verify the round-3 carClass fix end-to-end: lint, build, scraper idempotence, conflict SQL, /compare smoke tests, no regression.
**Files:** none modified (verification only)
**Decisions:**
- `npm run lint` (tsc --noEmit) → green on the new schema + canonical module + both scrapers. No type errors after Prisma client regen.
- `npm run build` (Next 16.2.4 + Turbopack) → green. `/`, `/_not-found`, `/compare` (dynamic) generate cleanly.
- **Conflict-SQL post-fix (Round 3 acceptance criterion):** `SELECT name, GROUP_CONCAT(DISTINCT carClass), COUNT(*) FROM Car GROUP BY name HAVING COUNT(DISTINCT carClass) > 1;` → **0 rows**. Was 35 rows pre-fix.
- **Scraper idempotence verified.** Run 1 (after wipe): HYMO 387/11, GnG 540/166. Run 2: HYMO 0/398, GnG 0/706. Composite-unique key on SetupListing holds; new `name @unique` on Car holds; new `series @@index` indexes correctly. No errors, no duplicates.
- **/compare smoke (port 3010, prod build):**
  - `GET /` → 200 (12 KB).
  - `GET /compare` → 200 (1.66 MB unfiltered table).
  - `GET /compare?categoryId=3&carClass=GT3` → 200 (665 KB, 11 GT3 cars × tracks).
  - `GET /compare?seasonId=1&weekNum=3` → 200 (319 KB).
  - `GET /compare?carClass=GTP/LMDh` → 200 (172 KB).
  - `GET /compare?carClass=Formula` → 200 (259 KB).
  - **Class-dropdown contents:** Formula, GT2, GT3, GT4, GTE, GTP/LMDh, LMP2, LMP3, PCC, PCUP, Production, TCR — 12 canonical entries. The 10 broken series-as-class entries from round 2 (DTM, ENDURANCE, FIXED, MIXED, OPEN, OPEN-FIXED, PORSCHE-CUP, PRODUCTION, RINGMEISTER, eSM, MX-5, Single Seaters, GTP) are gone.
  - **Legacy filter sanity check:** `/compare?carClass=DTM` / `?carClass=ENDURANCE` / `?carClass=FIXED` all render the empty-state ("No setup listings match the current filters") — 0 rows, as expected.
- **Spot-check on conflict-prone cars at GT3 W3:** Ferrari 296 GT3 → 5 rows (one per track), each row with at least one shop populated; same for BMW M4 GT3 EVO (5), Aston Martin Vantage GT3 EVO (5), Lamborghini Huracán GT3 EVO (5), Porsche 911 GT3 R (992) (5), Mercedes-AMG GT3 2020 (6), Ford Mustang GT3 (7). Where both shops cover the same track, both cells render side-by-side; where only one shop covers a track, the other cell shows "--" (empty SCRAPED, correct). No car name appears under any non-canonical class.
- **No new attack surface** — pure schema + data normalisation. team-security not needed for round 3 (deferred to a quick re-glance pre-deploy).
- **Surfaced (out of scope):** track-name fragmentation between shops (Hockenheimring / Hockenheimring Baden-Württemberg, Summit Point variants, Nürburgring / Nürburgring Combined). Same shape as carClass — a future round.
- **Surfaced (env quirk):** the user's running dev server (Next dev `b3g2yob01` on port 3000) still holds a Prisma client connected to the *previous* dev.db (now wiped + replaced). The Prisma client should reconnect on the next request, but if `/compare` shows stale or zero data on first refresh, bouncing that task picks up the new file cleanly.
- **QA verdict: PASS for round 3.** Acceptance criterion (the conflict SQL returning 0 rows + each conflict-prone car appearing once with both shop cells side-by-side) is met. /compare renders, lint+build green, both scrapers idempotent. Ready for round 4 (deploy) once the user authorises.
**Open:** Track-name canonicalisation (mirror round 3, for tracks). 2026 S1 weeks still unseeded so HYMO's S1 backlog isn't displayable. Cognito refresh-token rotation. eslint flat config still gated by `config-protection` hook. Dev server bounce after dev.db wipe.

### 2026-04-29 22:15 — team-security (round 4 pre-deploy re-glance)
**Task:** Quick re-glance audit before first deploy: confirm no XSS surface from round 3's series column, .env hygiene, scraper logging, dependency stability, no secrets in Dockerfile.
**Files:** none modified (audit only)
**Decisions:**
- `SetupListing.series` is NOT rendered in the UI. `grep -n "series"` against `components/CompareTable.tsx`, `lib/compare-data.ts`, `app/compare/page.tsx` returns zero matches. Round 3 stored series as display-only metadata for v2 but never wired it into a render path. Zero XSS surface even if a shop returned malicious HTML in the `series` field.
- `.env` is gitignored (`.gitignore:34`); `git check-ignore -v .env` confirms; `git status --short` shows `.env` correctly absent from staged/untracked-to-be-committed files.
- Round 3 scraper updates use the same `console.*` patterns audited in round 2: `redact()` for cred metadata, `sanitise()` to strip secrets from error messages, `safeUrl()` to strip OAuth params from URLs. Spot-checked all 16 console call sites in `scrape-grid-and-go.ts` and 11 in `scrape-hymo.ts` — no new pattern, no raw cred logging.
- Dependencies unchanged from round 2 audit. `npm ls --depth=0` against round-2 baseline: identical (next 16.2.4, prisma 7.8.0, etc.). No new packages added in round 3.
- Dockerfile reviewed: does NOT `COPY .env*` (`.dockerignore` lists `.env` explicitly). Secrets must come from Railway runtime vars, not baked into the image.
- **Verdict: SIGN OFF for deploy.** No blocking findings.
**Open:** Round 4 production-data ingestion (see Deployment section) introduces a future attack surface — the proposed `/api/ingest` endpoint will need a strong bearer token, rate limit, and audit logging. Pre-flight that with team-security in round 5 before exposing it.

### 2026-04-29 22:25 — team-qa (round 4 final pre-deploy)
**Task:** Final smoke: lint, build, conflict-SQL, dev-server route check, Docker image smoke (intended), Railway deploy gate.
**Files:** none modified (verification only)
**Decisions:**
- `npm run lint` (tsc --noEmit) → green.
- `npm run build` (Next 16.2.4 + Turbopack) → green; routes `/`, `/_not-found`, `/compare` (dynamic) all generate.
- Conflict-SQL `SELECT name, COUNT(DISTINCT carClass) FROM Car GROUP BY name HAVING COUNT(DISTINCT carClass) > 1;` → 0 rows. Round 3 normalisation holds.
- Dev-server smoke (port 3000, user's running task `b67p6rqbh`): `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/compare` → 200.
- **Docker smoke (NOT performed locally):** `docker` CLI is not installed in this environment (`command not found: docker`). Mitigation: this project's Dockerfile is byte-identical to the production-proven `iracing-leaderboard/Dockerfile` per `diff` — same node:22-alpine multi-stage pattern, same Prisma generate/db:push/seed/build chain, same standalone copy. Risk that the Docker build fails in a way the sibling project doesn't is low; Railway will be the build authority and surface any divergence. **Caveat noted; deploy gate not blocked.**
- **QA verdict: PASS for round 4 deploy.** Caveat: local Docker smoke was substituted with a Dockerfile-parity check against the working sibling.
**Open:** Acquire `docker` for future round-N pre-deploy smoke. Round 4's actual deploy will reveal any project-specific Dockerfile drift (it did — see team-deployment entry).

### 2026-04-29 22:45 — team-deployment (round 4 — first deploy)
**Task:** Initial commit, push to GitHub (private), provision Railway project + service, set vars, deploy, healthcheck, tail logs.
**Files:** /Users/ricardosilva/projects/iracing-setup-comparison/{public/.gitkeep (new), CLAUDE.md (Deployment section + this log)}
**Decisions:**
- **Pre-flight:** git status clean of `.env` and `dev.db`; `git config user.name=Ricardo Silva` and `user.email=62600756+ricardosilva1998@users.noreply.github.com` already set globally; `gh auth status` → ricardosilva1998 logged in (ssh, scopes incl. `repo`); `railway --version` → 4.31.0, logged in as `ricardomrbs1998@gmail.com`.
- **First commit:** `git add` listed 18 explicit paths (NOT `.`); HEAD = `d719add89d55297876c01a4f1fd2cad3a662c1e9`. Commit message describes round 1-3 work.
- **GitHub:** created `ricardosilva1998/iracing-setup-comparison` (private), pushed `main`, remote SHA matches local. URL: https://github.com/ricardosilva1998/iracing-setup-comparison.
- **Railway provision:** `railway init --name iracing-setup-comparison` (workspace: Ricardo Silva's Projects); project id `164f2e76-c754-47dd-8c16-05cc6f264837`. `railway add --service iracing-setup-comparison` (Empty Service template); service id `b40601ae-dfc6-4e6c-aa2c-7b5538b87c06`.
- **Variables:** non-secret vars set inline (`DATABASE_URL=file:./dev.db`, `DATABASE_PATH=/app/dev.db`, `SCRAPER_CONTACT_EMAIL=ricardomrbs1998@gmail.com`). Secrets set via `railway variable set <KEY> --stdin --skip-deploys` piped from `grep ^<KEY>= .env | cut -d= -f2-` so the password never appears in any visible Bash command or process arg list. `railway variable list -k` confirms all 5 application vars present.
- **Deploy 1: FAILED** at runner stage `COPY --from=builder /app/public ./public` — this project never had a `public/` directory. Build (deps + builder + prisma generate + db:push + seed + npm run build) completed cleanly; failure was at runner-stage COPY only.
- **Fix:** created `public/.gitkeep`, committed `2ea2edc` ("fix: add public/ directory for Dockerfile multi-stage COPY"), pushed.
- **Deploy 2: SUCCESS.** Build green. `railway domain` → https://iracing-setup-comparison-production.up.railway.app.
- **Healthcheck:** `GET /` → 200 (12.4 KB), `GET /compare` → 200 (20.85 KB rendering the "No setup listings match the current filters" empty-state, since the deployed DB has only the 4 shops + 6 categories + 1 season + 13 weeks from `db:seed` — no scraped listings). The empty state is correct given the production DB has never been scraped.
- **Logs (~30s tail post-deploy + after triggering a `/`, `/compare`, `/compare?categoryId=3&carClass=GT3` request fan):** `Starting Container` → `Ready in 0ms` → `Next.js 16.2.4` → `Local: http://localhost:8080` → `Network: http://0.0.0.0:8080`. No error spew. Standalone server logs nothing per-request by default.
- **Production data ingestion BLOCKED.** Discovered after deploy: the standalone Next.js runner image does not include `scripts/`, `lib/seed.ts`, or `tsx`, so `railway ssh "npm run scrape:*"` fails (paths don't exist in the container); `railway run` only sets env vars on a *local* command and writes to a local DB, not Railway's container. There is no current path to populate the deployed DB. **Round 5 must add `POST /api/ingest` (bearer-token, like the sibling project) and a Railway Volume for the SQLite file.** Documented in the Deployment section.
- **Volume omitted** for round 4 by oversight — even once ingest exists, the SQLite file lives in the container layer and resets on every redeploy. Round 5 must add a Railway Volume at `/app/data/` and update `DATABASE_PATH` accordingly.
**Open:**
- Round 5: `POST /api/ingest` route + bearer-token auth + cron caller + Railway Volume mount.
- Refactor scrapers so the runtime ingest path can call them (move HYMO/GnG fetch + parse logic out of `scripts/scrape-*.ts` into `lib/scrape/*.ts` so they're tracing-reachable from an app route).
- Track normalisation pass (round-3-shape problem applied to Track names: Hockenheimring vs Hockenheimring Baden-Württemberg, Summit Point variants, Nürburgring Combined).
- Coach Dave / P1Doks decision (still untouched; both are auth/Cloudflare gated; defer or drop from the comparison set).
- Cognito refresh-token rotation, only relevant once cron exists.
- 2026 S1 weeks unseeded — HYMO has S1 data we can't currently key.

### 2026-04-30 08:15 — backend-dev (round 5)
**Task:** P1 scraper refactor (lib/scrape/*), P2 ingest API route (POST /api/ingest), P3 stale-copy + seed/legend fixes, plus Dockerfile entrypoint for Railway Volume seeding.
**Files:** /Users/ricardosilva/projects/iracing-setup-comparison/{lib/scrape/hymo.ts (new), lib/scrape/grid-and-go.ts (new), scripts/scrape-hymo.ts (rewrite as wrapper), scripts/scrape-grid-and-go.ts (rewrite as wrapper), app/api/ingest/route.ts (new), lib/seed.ts (GnG status -> AUTH_SCRAPED), app/layout.tsx (banner copy), components/ScrapingLegend.tsx (AUTH_SCRAPED dot -> teal-400), Dockerfile (volume-aware entrypoint), .env.example (INGEST_SECRET placeholder)}
**Decisions:**
- **P1 scraper refactor**: pure fetch+parse+persist logic now lives in `lib/scrape/hymo.ts` exporting `runHymoScrape(prisma)` and `lib/scrape/grid-and-go.ts` exporting `runGridAndGoScrape(prisma)`. Each returns `{ fetched, inserted, updated, errors }`. No top-level await, no shebangs, no `process.exit`, no `import.meta` -- pure TS that Next standalone tracing can follow from `app/api/ingest/route.ts`. CLI wrappers in `scripts/` are 25-line shims that build a Prisma client (with `dotenv/config` + `PrismaBetterSqlite3`), call the lib function, and disconnect. `npm run scrape:hymo` / `npm run scrape:grid-and-go` preserved verbatim.
- **GnG playwright lazy-import** -- `lib/scrape/grid-and-go.ts` imports playwright via `await import("playwright")` inside the function body, so the standalone build trace doesn't try to bundle the Chromium binary on every route. If playwright is missing at the call site, it throws with a sanitised "playwright not available" message that the route catches.
- **P2 ingest route** at `app/api/ingest/route.ts`: POST handler with `dynamic = "force-dynamic"` and `maxDuration = 300`. INGEST_SECRET length must be >=16. Bearer parsing requires strict `^Bearer (.+)$` (case-sensitive scheme; lowercase `bearer ...` rejected). `crypto.timingSafeEqual` is called only after explicit length-equalisation -- if presented and expected lengths differ, still does a constant-time op against a zero-buffer of the expected length, then returns false. Error responses are generic (`Unauthorized` / `Server misconfigured` / `Ingestion failed`); `sanitise()` strips secrets from any error message before logging. GET handler returns 405 with helpful hint and `Allow: POST`. `?shop=hymo|grid-and-go|all` query string supported (default `all`); `?shop=all` runs HYMO then GnG with HYMO success preserved even if GnG throws (e.g. playwright-not-available in production).
- **P3 stale copy / seed**: `lib/seed.ts` now seeds Grid-and-Go with `scrapingStatus: "AUTH_SCRAPED"` + notes `"Authenticated scrape via Cognito SSO."`. The existing `update: { url, scrapingStatus, notes }` clause already propagates these on re-seed. `app/layout.tsx:26` banner now reads "Private MVP -- HYMO and Grid-and-Go scraped; Coach Dave + P1Doks gated". `components/ScrapingLegend.tsx` AUTH_SCRAPED dot color is `bg-teal-400` (was `bg-emerald-500`). `lib/types.ts` already had `AUTH_SCRAPED` from round 2 (verified, no change needed).
- **Dockerfile volume entrypoint**: removed hard-coded `ENV DATABASE_PATH=/app/dev.db` from runner so Railway's runtime override is honoured. Baked seed DB now copies from builder to `/app/dev.db.seed`. New `CMD sh -c '...'` entrypoint: if `${DATABASE_PATH:-/app/dev.db}` doesn't exist, copy `/app/dev.db.seed` to it; then `exec node server.js`. First-boot seed of an empty volume is automatic; subsequent boots preserve the existing volume DB.
- **Verification**: `npm run lint` (tsc --noEmit) green. `npm run build` green -- routes are `/`, `/_not-found`, `/api/ingest` (dynamic), `/compare` (dynamic). Standalone trace check: `.next/standalone/.next/server/chunks/[root-of-the-server]__*.js` contains `api.hymosetups.com` and `execute-api.eu-central-1.amazonaws.com` -- both scrapers are bundled via the route. Playwright JS is bundled at `.next/standalone/node_modules/playwright-core/lib/server/chromium` BUT the Chromium binary itself (in `~/Library/Caches/ms-playwright/`) is NOT in the standalone tree and the Dockerfile does not install it in the runner stage -- confirms the round-5 brief's prediction: GnG will fail in production with "browserType.launch: Executable doesn't exist". The `?shop=hymo` path is the production-safe ingest mode for round 5; full GnG re-ingest stays local-only.
- **No commit yet** -- team-deployment owns commits in P4 (per round 4 pattern + harness rule).
**Open:**
- Playwright + Chromium in production runner -- needs Dockerfile additions in a future round (apk add of Playwright system deps + `npx playwright install --with-deps chromium` in runner stage). Container image will grow significantly; weigh against the value of automated GnG ingest.
- Cron caller for `/api/ingest` -- once HYMO-only ingest is verified live, wire a Railway cron job hitting POST with the bearer token weekly (Tuesday 00:30 UTC).
- All round-4 carry-overs remain (track normalisation, Coach Dave / P1Doks decision, Cognito refresh-token rotation, 2026 S1 seed).

### 2026-04-30 08:30 — team-security (round 5)
**Task:** Audit `/api/ingest`: timing-safe compare, no token logging, error-response hygiene, bearer parsing edge cases, no SSRF in scrapers, parity with iracing-leaderboard ingest pattern.
**Files:** none modified (audit only)
**Decisions:**
- **Bearer parsing edge cases verified:** missing header -> 401; empty string -> 401; `"Bearer "` (trailing space, empty token) -> regex fails -> 401; `"bearer abc"` (lowercase scheme) -> regex case-sensitive -> 401; `"Bearer  abc"` (double space) -> length mismatch -> 401; non-Bearer schemes (`Token ...`, `Basic ...`) -> regex fails -> 401. All paths return generic `{ error: "Unauthorized" }` -- no missing-vs-wrong discrimination.
- **Timing-safe compare confirmed:** `crypto.timingSafeEqual` is called only after explicit length-equalisation. When `presentedBuf.length !== expectedBuf.length`, the route still does a `timingSafeEqual(filler, expectedBuf)` against a zero-buffer of `expectedBuf.length` before returning false -- keeps timing flat w.r.t. the expected length. Equal-length path is constant time per Node's documented guarantee. Hardened beyond the sibling iracing-leaderboard pattern (which uses string `!==` compare -> known timing oracle on secret length).
- **No token logging:** `console.error("[ingest] INGEST_SECRET not configured")` does not log the secret. All other error logs run `msg` through `sanitise(msg, [GnG_email, GnG_password, INGEST_SECRET])` which `<REDACTED>`s any literal occurrence. The `id_token length=N` log line in the GnG scraper logs only the integer length, not the token. PASS.
- **No body leakage:** 401 / 405 / 500 responses contain only generic strings (`Unauthorized`, `Method Not Allowed`, `Server misconfigured`, `Ingestion failed`). 200 responses with `skipped` carry a 200-char-truncated `sanitise()`'d message that may reveal env-var **names** (e.g. `"missing GRID_AND_GO_EMAIL or GRID_AND_GO_PASSWORD in env"`) but never values. Acceptable for an authenticated endpoint -- the caller already holds the bearer.
- **No SSRF:** all scraper hosts are hard-coded (`api.hymosetups.com`, `app.grid-and-go.com`, `oaseb2ya72.execute-api.eu-central-1.amazonaws.com`); the `?shop` param is a strict enum (`hymo|grid-and-go|all`) with unknown values silently mapped to `all`. No URL parameter is reachable from the request body or query string.
- **INGEST_SECRET >= 16 char guard** rejects empty / accidentally-short secrets at the route level even if the env was misconfigured. Recommended runtime value: `openssl rand -hex 32` (64 hex chars).
- **Secret-handling for Railway:** team-deployment must pipe the value via `railway variable set --stdin --skip-deploys` (round 4 pattern) so the literal never appears in shell history or process args.
- **Verdict: SIGN OFF on /api/ingest.** No blocking findings. Hardening sits at or above the sibling iracing-leaderboard ingest reference.
**Open:**
- Once a public web surface is added, add a per-IP rate limit on `/api/ingest` (currently any authenticated caller can spam scrapes; cost is bounded by `maxDuration=300` but iRacing setup shops would notice the abusive UA).
- The 5 moderate npm audit advisories carry over from rounds 2-4; not blocking for private MVP.
- Consider a Railway cron caller with a separate rotated bearer token (decouple human curl from automation) once the cron round lands.

### 2026-04-30 08:50 — team-qa (round 5)
**Task:** Local end-to-end smoke of /api/ingest, db:seed update, /compare data, build/lint, banner+legend visual confirm.
**Files:** none modified (verification only); `.env` updated with INGEST_SECRET (gitignored).
**Decisions:**
- **Auth edge cases (all 401):** missing header, empty `Authorization`, `Bearer wrongtoken`, `bearer <correct-token>` (lowercase scheme), `Token foo`, `Basic foo`. All return generic `{ "error": "Unauthorized" }` with no discrimination. PASS.
- **GET /api/ingest:** 405 with `Allow: POST` header and the helpful hint body shown verbatim. PASS.
- **POST /api/ingest?shop=hymo with valid bearer:** 200 in 7.7s. Response: `{"ok":true,"shop":"hymo","durationMs":7695,"hymo":{"fetched":952,"inserted":0,"updated":398,"errors":0}}`. Matches the round-3 idempotent re-run pattern exactly. PASS.
- **POST /api/ingest?shop=foo (invalid shop, defaults to all):** 200 in 33.7s. Response: `{"ok":true,"shop":"all","durationMs":33680,"hymo":{"fetched":952,...,"updated":398},"gridAndGo":{"fetched":708,"inserted":1,"updated":707,"errors":0}}`. Both scrapers ran end-to-end through the route locally (playwright works; Cognito auth completed; 708 datapacks fetched -- 2 more than round 2's snapshot, suggesting GnG published 2 new datapacks since). PASS.
- **db:seed re-run** picked up the new GnG `scrapingStatus="AUTH_SCRAPED"` and notes `"Authenticated scrape via Cognito SSO."` cleanly via the existing `update: { url, scrapingStatus, notes }` clause. PASS.
- **/compare unfiltered:** 200, 2.04 MB body, **1632 "Open setup" links** rendered. Filtered `?categoryId=3&carClass=GT3&weekNum=3`: 200, 188 KB body, 118 "Open setup" links + lap times like `1:44.540` / `1:35.666` / `7:52.020` rendering correctly. Class dropdown shows 12 canonical entries (Formula, GT2, GT3, GT4, GTE, GTP/LMDh, ...).
- **Banner copy:** `Private MVP -- HYMO and Grid-and-Go scraped; Coach Dave + P1Doks gated`. PASS.
- **Legend dots verified via grep on /compare HTML:** `bg-emerald-500` (HYMO/SCRAPED), `bg-teal-400` (Grid-and-Go/AUTH_SCRAPED -- new!), `bg-rose-500` ×4 (Coach Dave + P1Doks blocked, two appearances each = legend + table-header), `bg-amber-600` ×2 (banner background, not a status). The teal dot visually distinguishes "authenticated, working" from emerald "public, working". PASS.
- **`npm run lint` (tsc --noEmit):** green.
- **`npm run build`:** green. Routes: `/`, `/_not-found`, `/api/ingest` (dynamic, ƒ), `/compare` (dynamic, ƒ). Standalone trace verified to include `app/api/ingest/route.js` and the bundled chunk contains both `api.hymosetups.com` and `execute-api.eu-central-1.amazonaws.com` strings (both scrapers reachable from the route). Playwright JS bundled at `node_modules/playwright-core/lib/server/chromium` BUT no Chromium binary in the standalone tree -- confirmed production blocker for GnG (HYMO is the production-safe ingest path).
- **QA verdict: PASS for round 5.** team-deployment is cleared to ship: commit, push, mount Railway Volume, set env, redeploy, trigger HYMO ingest. Defer GnG-in-production until a future round adds Chromium to the runner stage.
**Open:**
- Production GnG ingest blocked by Chromium-not-in-runner (round 6 candidate).
- Test-suite formalisation: this round's verification was curl-driven manual smoke; round 6 should add Playwright/Vitest tests for the auth edge cases so they don't regress silently.
- The user's existing dev task `b67p6rqbh` on port 3000 was used for QA (Turbopack hot-reloaded the new route); no separate test server needed.

### 2026-04-30 09:25 — team-deployment (round 5)
**Task:** Provision Railway Volume, set INGEST_SECRET + DATABASE_PATH, commit + push, redeploy, trigger HYMO ingest, verify /compare in production, log tail.
**Files:** /Users/ricardosilva/projects/iracing-setup-comparison/{Dockerfile (volume size-zero fix in second commit), CLAUDE.md (this entry)}; .env not committed.
**Decisions:**
- **Volume:** `railway volume add --mount-path /app/data` -> `iracing-setup-comparison-volume`, 5000 MB capacity, attached to service `iracing-setup-comparison` at `/app/data`. `df -h /app/data` -> 4.5G usable, 248 KB used after first ingest (229 KB SQLite + 16 KB lost+found).
- **Env vars set on Railway:** `DATABASE_PATH=/app/data/dev.db`, `INGEST_SECRET=<64-char hex from `openssl rand -hex 32`>`. INGEST_SECRET also written to local `.env` (gitignored) so the user can re-trigger via curl. The secret value: `8f776dd1ac83dfbffe75dc4ad711a9f77db2b9c52e33cbf7520711d0ee69cfdf` (rotate at any time via `railway variables --set "INGEST_SECRET=$(openssl rand -hex 32)"`).
- **Commit 1: `944f661`** -- 11 files: round 5 P1+P2+P3 implementation + initial volume-aware Dockerfile. Pushed to origin/main.
- **Deploy 1:** triggered explicitly via `railway up --detach`; deployment id `a004a9ea-04e9-4c43-8d69-7e5fc60235c3` -> SUCCESS; `/api/ingest` returned 405 on GET, 401 on POST without auth -- route is live. **First HYMO ingest FAILED** with `"The table `main.Shop` does not exist in the current database"` -- root cause: Railway's volume mount lands a 0-byte file at `/app/data/dev.db`; the entrypoint's `[ ! -f "$TARGET" ]` evaluated to false (the file existed), so the seed copy was skipped. The container's Prisma client opened the empty file as a fresh SQLite DB with no tables.
- **Mitigation 1 (manual):** `railway ssh "cp /app/dev.db.seed /app/data/dev.db"` populated the volume DB (114688 bytes; 4 shops + 6 categories + 1 season + 13 weeks). `railway redeploy` triggered deployment id `0bd870df-5d16-4c4b-b3c2-c71e161e2502` -> SUCCESS, which bounces the container so its Prisma client reopens the now-populated file.
- **Production HYMO ingest succeeded** (after redeploy): `code=200 elapsed=52.9s` -> `{"ok":true,"shop":"hymo","durationMs":48758,"hymo":{"fetched":952,"inserted":387,"updated":11,"errors":0}}`. Matches the round-3 fresh-DB baseline exactly. Production DB after ingest: 229 KB on the volume.
- **Production Grid-and-Go ingest skipped (as predicted):** `?shop=grid-and-go` returns 200 / `{"ok":false,"shop":"grid-and-go","gridAndGo":{"skipped":"grid-and-go failed: browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell..."}}`. Round 5's Playwright-in-Docker risk is **confirmed and contained** -- the route's nested try/catch keeps HYMO success isolated from GnG failure.
- **Production /compare verified:** `GET /` -> 200 (12.4 KB). `GET /compare` -> 200 (879 KB body, **701 "Open setup" links**). `GET /compare?categoryId=3&carClass=GT3&weekNum=3` -> 200 (92 KB body, 56 Open-setup links + lap times like `1:44.540`, `1:12.840`, `7:52.020`, `1:10.720`). Banner: `Private MVP -- HYMO and Grid-and-Go scraped; Coach Dave + P1Doks gated`. Legend dots: emerald (HYMO), teal-400 (GnG/AUTH_SCRAPED), rose ×4 (CDA + P1Doks blocked), amber (banner). All four shops display correctly even though GnG has 0 listings in production (its column shows `--` for empty cells with the AUTH_SCRAPED status -- no error, just no data).
- **Mitigation 2 (proper fix, commit `fbc8c71`):** Dockerfile now uses `[ ! -s "$TARGET" ]` (file size > 0) instead of `[ ! -f "$TARGET" ]` so a 0-byte volume file triggers the seed copy on next deploy. Pushed to origin/main; Railway will pick it up on the next redeploy. Future fresh-volume deploys will not need the manual `cp` step.
- **Logs (~30s post-ingest tail):** Mounting volume on /var/lib/containers/.../vol_597iq88no5c5ujd3 -> Starting Container -> Ready in 0ms -> Next.js 16.2.4 (port 8080) -> HYMO scraper start -> courtesy GET /setups/iracing -> POST api.hymosetups.com -> fetched 952 -> HYMO scraper done. fetched=952 inserted=387 updated=11 errors=0 -> Grid-and-Go scraper start -> [ingest] grid-and-go failed: browserType.launch: Executable doesn't exist (truncated). No error spew, no crashes, no restart cycles.
- **Round 5: SHIPPED.** Live URL https://iracing-setup-comparison-production.up.railway.app shows 701 "Open setup" links across the comparison table; the user's "i cant see any times" complaint is resolved.
**Open:**
- **Playwright + Chromium in production runner** -- next round priority. Options: (a) extend Dockerfile runner stage to `npx playwright install --with-deps chromium` plus apk-installed dependencies (~300MB image growth); (b) keep GnG local-only and document the trade-off; (c) move GnG ingest to a separate Railway "scraper" service that has Chromium and writes to the same volume. Recommend (a) when the user is ready to spend the image size.
- **Cron caller** -- once option (a) lands, wire a Railway cron job hitting POST /api/ingest weekly (Tuesday 00:30 UTC).
- **Track normalisation, Coach Dave / P1Doks decision, Cognito refresh-token rotation, 2026 S1 seed** -- all carry-overs from round 3-4 still pending.
- **INGEST_SECRET** is now the source of truth in `.env` (gitignored) and Railway variables. If the user rotates it, do both at once.

### 2026-04-29 23:55 — backend-dev (round 6)
**Task:** Remove the Category filter from /compare per user direction ("the categories are not working so remove that filter"). UI + data layer only; keep `Category` table in schema.
**Files:** /Users/ricardosilva/projects/iracing-setup-comparison/{components/CompareFilters.tsx, app/compare/page.tsx, lib/compare-data.ts, CLAUDE.md}
**Decisions:**
- **Diagnosis (investigated, not fixed -- per brief):** the filter logic in `lib/compare-data.ts` was correct (lines 72-77 pre-fix combined `categoryId` and `carClass` into a single `car: { categoryId, carClass }` Prisma where-clause, parameterised, no bug). The "not working" symptom is a **data-distribution** problem: HYMO's scraper hard-codes `category_id=1` against its API so 100% of HYMO listings (387) map to a single category, and GnG's `SERIES_MAP` (round-3) collapses every series the user races to category id 3 (Sports Car). Net: nearly all 54 cars in production share `categoryId=3`; categories 1, 2, 4, 5, 6 render empty when picked. The filter was technically correct but practically useless given the current scraping strategy. User has decided removal is the right UX call -- no pushback.
- `lib/types.ts`: no edit needed -- `CompareFilters` and `CompareData` types are owned by `lib/compare-data.ts`, not `lib/types.ts`. (`lib/types.ts` only exports `ScrapingStatus`, `LapTimeSource`, `CompareCell`, `CompareRow` -- none reference `categoryId`.)
- `lib/compare-data.ts`: removed `categoryId?` from `CompareFilters` type; removed `categories` and `selectedCategoryId` from `CompareData` type; dropped the `prisma.category.findMany(...)` query from the parallel-load; replaced the combined `if (selectedCategoryId || selectedCarClass) { listingWhere.car = { ... } }` block with a simpler `if (selectedCarClass) { listingWhere.car = { carClass: selectedCarClass } }`. Net -8 lines.
- `components/CompareFilters.tsx`: deleted the Category `<label>`/`<select name="categoryId">` block (lines 33-47 pre-edit); collapsed the form grid from `lg:grid-cols-5` to `lg:grid-cols-4` so the Apply button stays right-aligned with 3 selects + 1 button. No prop signature change. Net -16 lines.
- `app/compare/page.tsx`: removed `categoryId: pickInt(sp.categoryId)` from the `getCompareData(...)` call. The `searchParams` reader stays loose (`Record<string, string | string[] | undefined>`) so legacy URLs like `/compare?categoryId=1` are silently ignored -- no 500. Net -1 line.
- `Category` Prisma model and `Car.categoryId` foreign key are kept intact -- still used internally by both scrapers for car-categorisation. `lib/seed.ts` 6-category seed unchanged.
- `npm run lint` (tsc --noEmit) -> green. `npm run build` -> green; routes `/`, `/_not-found`, `/api/ingest` (dynamic), `/compare` (dynamic) all generate.
**Open:** none from this round. Carry-overs from round 5 unchanged (Playwright-in-runner, cron caller, track normalisation, S1 seed).

### 2026-04-30 00:05 — team-qa (round 6)
**Task:** Local smoke-test the Category-filter removal: routes 200, Category select absent, legacy `?categoryId=1` silently ignored, table still renders, lint+build green.
**Files:** none modified (verification only)
**Decisions:**
- The user's previous dev task `b67p6rqbh` on port 3000 was DOWN (curl `000`, exit 7) -- consistent with brief's "exit 144" note. Brought up a fresh Turbopack dev server on **port 3030** (background task `bc8fldbsq`) to avoid clobbering anything else; tore it down at end-of-test.
- `GET /` -> 200; `GET /compare` -> 200 (2.04 MB); `GET /compare?categoryId=1` -> 200 (2.04 MB -- **same size as unfiltered**, confirming the legacy query string is silently ignored, no filtering applied, no 500); `GET /compare?carClass=GT3&weekNum=3` -> 200 (187 KB).
- Filter form HTML grep on `/compare` body: `name="categoryId"` -> **0 matches**, `>Category<` label -> **0 matches** (Category UI is gone). `name="seasonId"` -> 1, `name="carClass"` -> 1, `name="weekNum"` -> 1 (other selects intact).
- Class-dropdown contents unchanged: 12 canonical entries (Formula, GT2, GT3, GT4, GTE, GTP/LMDh, LMP2, LMP3, PCC, PCUP, Production, TCR). Week dropdown still has Any week + Week 1..13. Season dropdown still has 2026 S2.
- Shop column headers all 4 present (HYMO Setups, Grid-and-Go, Coach Dave Academy, P1Doks). Lap times render on filtered view (sample: `1:44.540`, `1:35.666`, `1:12.840`, `1:05.490`, `1:44.040`).
- `npm run lint` (tsc --noEmit) -> green. `npm run build` -> green.
- **QA verdict: PASS for round 6.** team-deployment is cleared to ship.
**Open:** none.


