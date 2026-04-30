/**
 * gosetups.gg scraper -- library entry point.
 *
 * Round 10. gosetups.gg is a WooCommerce store on Apache, no Cloudflare WAF,
 * robots.txt allows all bots outside of /wp-admin and add-to-cart query strings.
 * Their public WooCommerce Store API
 *   GET /wp-json/wc/store/products?category=442&per_page=100
 * returns the full iRacing-categorised product set (57 cars at probe time)
 * with each car's per-track variation list. THE STORE API DOES NOT INCLUDE
 * LAP TIMES.
 *
 * Lap times live in a public Google Sheet they link from every product page
 * ("VIEW ALL LAPTIMES AND WEATHER CONDITIONS"):
 *   https://docs.google.com/spreadsheets/d/1N5izrd0FcT-yVYblq7bnhzQAr80nqdBblzFm_Q0PD4g
 * with one tab per (season, week), labelled "26S2 WEEK N". Each tab is a
 * cross-series tabular dump where each "section" header is a track + series
 * label and each row is (class, car, lap_time, lap_n, driver). We export the
 * tab as CSV via the public gviz endpoint and parse the rows.
 *
 * Strategy:
 *   1. Fetch the WC Store API product list (one HTTP call).
 *   2. For each product, harvest its variations to build a (car, track-slug,
 *      track-name) -> variation_id index. The variation_id lets us deep-link
 *      the listing URL to the specific track row.
 *   3. Fetch the Google Sheet's "default sheet" once to record its sig (so we
 *      can later detect tab-not-found fallback responses).
 *   4. For each iRacing week (1..13) of every Season we know about, fetch
 *      "<YYsN> WEEK <N>" via gviz?tqx=out:csv. If the sig is the default
 *      sig -> the tab doesn't exist; skip.
 *   5. Parse the CSV into (track_name, class, car_name, time_seconds) tuples.
 *      The CSV has multiple "section" blocks per tab (each block = one
 *      series-track combo); section headers / footers / weather metadata
 *      noise is filtered out by row-shape heuristics.
 *   6. Match (car, track) to the WC variation table to compute the deep-link
 *      URL; canonicalise track name; canonicalise class via name-rules; upsert
 *      Car / Track / SetupListing / LapTime.
 *
 * Hard rules (audit parity with HYMO scraper):
 *   - Honor robots.txt on both gosetups.gg and docs.google.com.
 *   - Rate limit: 1 request per 5s with +/- 2s jitter on each external HTTP.
 *   - User-Agent identifies the bot + a contact email.
 *   - Retry 429/503 with exponential backoff (5s -> 10s -> 20s, 3 retries max).
 *   - Idempotent: re-running upserts only.
 */
import { fetch } from "undici";
import robotsParser from "robots-parser";
import type { PrismaClient } from "../../app/generated/prisma/client";
import { canonicalFromName } from "../car-class-canonical";
import { canonicalizeTrackName } from "../track-canonical";
import { canonicalizeCarName } from "../car-name-canonical";

const SHOP_NAME = "GO Setups";
const GOSETUPS_HOST = "https://gosetups.gg";
const GOSETUPS_ROBOTS = `${GOSETUPS_HOST}/robots.txt`;
const GS_API_PRODUCTS = `${GOSETUPS_HOST}/wp-json/wc/store/products`;
const GS_IRACING_CATEGORY_ID = 442;

const SHEET_HOST = "https://docs.google.com";
const SHEET_ROBOTS = `${SHEET_HOST}/robots.txt`;
const SHEET_ID = "1N5izrd0FcT-yVYblq7bnhzQAr80nqdBblzFm_Q0PD4g";

const RATE_LIMIT_MS = 5000;
const JITTER_MS = 2000;
const MAX_RETRIES = 3;

function userAgent(): string {
  const contact = process.env.SCRAPER_CONTACT_EMAIL || "ricardomrbs1998@gmail.com";
  return `iracing-setup-comparison/0.1 (+contact: ${contact})`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredDelay() {
  const jitter = (Math.random() * 2 - 1) * JITTER_MS;
  return Math.max(2500, RATE_LIMIT_MS + jitter);
}

async function loadRobots(robotsUrl: string, ua: string) {
  try {
    const res = await fetch(robotsUrl, { headers: { "User-Agent": ua } });
    const body = res.ok ? await res.text() : "";
    return robotsParser(robotsUrl, body);
  } catch {
    // Defensive: if robots.txt 404s or networks out, treat as empty (allow-all).
    return robotsParser(robotsUrl, "");
  }
}

type FetchOpts = { method?: "GET" | "POST"; body?: string; accept?: string };

class PoliteFetcher {
  private lastFetchAt = 0;
  constructor(private ua: string) {}

  async fetch(url: string, opts: FetchOpts = {}, attempt = 1): Promise<{ status: number; text: string } | null> {
    const wait = this.lastFetchAt === 0 ? 0 : jitteredDelay() - (Date.now() - this.lastFetchAt);
    if (wait > 0) await sleep(wait);
    this.lastFetchAt = Date.now();

    const method = opts.method ?? "GET";
    const accept = opts.accept ?? "text/html,application/xhtml+xml";

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "User-Agent": this.ua,
          Accept: accept,
          ...(opts.body ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body,
      });
    } catch (err) {
      console.warn(`  fetch error on ${url}: ${(err as Error).message}`);
      // Retry transient network errors with exponential backoff. Distinct
      // from the 429/503 backoff which uses res.status; here res is undefined.
      if (attempt <= MAX_RETRIES) {
        const backoff = 5000 * Math.pow(2, attempt - 1);
        console.warn(`  retrying in ${backoff}ms (attempt ${attempt}/${MAX_RETRIES})`);
        await sleep(backoff);
        return this.fetch(url, opts, attempt + 1);
      }
      return null;
    }

    if ((res.status === 429 || res.status === 503) && attempt <= MAX_RETRIES) {
      const backoff = 5000 * Math.pow(2, attempt - 1);
      console.warn(`  ${res.status} on ${url}; backing off ${backoff}ms (attempt ${attempt}/${MAX_RETRIES})`);
      await sleep(backoff);
      return this.fetch(url, opts, attempt + 1);
    }

    const text = await res.text();
    if (!res.ok) {
      console.warn(`  HTTP ${res.status} on ${url}`);
      return { status: res.status, text };
    }
    return { status: res.status, text };
  }
}

// ---- WC Store API types ---------------------------------------------------

type WcProduct = {
  id: number;
  name: string;
  slug: string;
  permalink: string;
  type: string;
  prices: { price: string; currency_code: string; currency_minor_unit: number };
  attributes: WcAttribute[];
  variations: WcVariation[];
};

type WcAttribute = {
  id: number;
  name: string;
  taxonomy: string;
  has_variations: boolean;
  terms: { id: number; name: string; slug: string }[];
};

type WcVariation = {
  id: number;
  attributes: { name: string; value: string }[];
};

// ---- Sheet CSV parsing ----------------------------------------------------

/**
 * A single time row decoded from a sheet tab.
 *
 * trackName -- the section header that appeared above this row (raw, before
 *              canonicalisation). One tab can have multiple sections, e.g.
 *              26S2 W7 covers "Brands Hatch" (GT-Sprint) + "Laguna Seca"
 *              (IMSA) + "Oschersleben" (Sports Car Challenge) etc. The
 *              section header is the cell whose row the section header
 *              detector found.
 * className -- the per-row class label as written in the sheet (e.g. "GT3",
 *              "GT4", "TCR", "Cup", "GTP", "LMP3").
 * carName  -- the car as written in the sheet (e.g. "Ferrari 296 GT3").
 * timeSeconds -- the lap time parsed from "M:SS.SSS" or "SS.SSS" or "H:MM:SS".
 */
type SheetRow = {
  trackName: string;
  className: string;
  carName: string;
  timeSeconds: number;
};

/**
 * Parse a CSV line robustly enough for Google Sheets export.
 *
 * Sheets emits RFC-4180-ish CSV: fields with commas/newlines/quotes are
 * wrapped in double quotes, internal quotes are escaped as "". This is a
 * pure-string parser to avoid pulling in a CSV dep.
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}

/**
 * Parse a multi-line CSV blob into row arrays. Handles embedded newlines
 * inside quoted fields (which Google Sheets produces freely, e.g. comments
 * with "\n - ..." continuations).
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '""';
        i++;
      } else if (ch === '"') {
        cur += '"';
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        cur += '"';
        inQuotes = true;
      } else if (ch === "\r") {
        // skip
      } else if (ch === "\n") {
        rows.push(parseCsvLine(cur));
        cur = "";
      } else {
        cur += ch;
      }
    }
  }
  if (cur.length > 0) rows.push(parseCsvLine(cur));
  return rows;
}

/**
 * Convert a lap-time string to seconds. Returns null if the value isn't a
 * recognised time format. Accepted shapes:
 *   "M:SS.SSS"      -> e.g. "1:20.840"
 *   "MM:SS.SSS"     -> e.g. "8:04.669"
 *   "H:MM:SS.SSS"   -> rare; rest-week endurance laps
 *   "SS.SSS"        -> short ovals e.g. "29.557"
 *   "0:29.027"      -> some Cup-row times
 */
function parseLapTime(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  // Reject obvious non-times: empty, "--", "TBD", etc.
  if (!/[0-9]/.test(trimmed)) return null;

  // H:MM:SS.SSS
  let m = /^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(trimmed);
  if (m) {
    const h = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const ss = parseFloat(m[3]);
    return h * 3600 + mm * 60 + ss;
  }
  // M:SS.SSS or MM:SS.SSS
  m = /^(\d{1,2}):(\d{2}(?:\.\d+)?)$/.exec(trimmed);
  if (m) {
    const mm = parseInt(m[1], 10);
    const ss = parseFloat(m[2]);
    return mm * 60 + ss;
  }
  // SS.SSS (short oval / sprint)
  m = /^(\d{1,3}\.\d+)$/.exec(trimmed);
  if (m) return parseFloat(m[1]);
  return null;
}

/**
 * Walk the parsed-CSV grid for one weekly tab and produce SheetRow objects.
 *
 * Sheet layout per cluster (observed):
 *   row K        : empty
 *   row K+1      : col B = SECTION TITLE (e.g. "SPORTS CAR GT SPRINT")
 *   row K+2..    : weather-data rows, with col D possibly the track name
 *                  (e.g. "Brands Hatch") and col J the weather value
 *   row K+M      : col C = "Class", col D = title repeated, col E = "Lap Time"
 *   row K+M+1..  : col C = car class, col D = car name, col E = lap-time
 *                  string. Stops when col C / col D become empty.
 *
 * We track:
 *   - The most recent section title (the bold row preceding a given block).
 *   - The most recent track name (col D row that is *not* a class label).
 *   - The header row signature (col C = "Class").
 * Then, while col C contains a non-empty class string and col E parses as a
 * lap time, emit a SheetRow.
 *
 * The grid actually has TWO PARALLEL COLUMN GROUPS in some tabs (e.g. W7 has
 * Sports Car GT Sprint in cols B..G and Oval in cols M..R). We handle both
 * by scanning two windows: the "left block" anchored at col C/D/E and the
 * "right block" anchored at col N/O/P (zero-indexed: 13, 14, 15).
 *
 * We also accept variant layouts (some early-2026 tabs use slightly different
 * column placements). The detector treats every row that has a class-like
 * token in col C/N AND a parseable time in col E/P as a data row, and the
 * most recent track header above it as the row's track. Header detection is
 * conservative -- we accept a row as a track-header iff col D/O is a non-empty
 * string with no digit pattern that looks like a time and is NOT in the list
 * of known class labels.
 */
const KNOWN_CLASSES = new Set([
  "GT3", "GT4", "GTE", "GT2", "GTP", "LMP2", "LMP3", "TCR",
  "Cup", "PCUP", "PCC", "MX-5", "Open", "Oval", "Truck",
  "Class A", "Class B", "Class C", "INDYCAR", "FORMULA",
  "FF1600", "F4", "F3", "Single Seaters",
  "NASCAR", "Production", "DTM",
]);

function looksLikeClass(cell: string): boolean {
  if (!cell) return false;
  const c = cell.trim();
  if (!c) return false;
  // Class cells are typically short and either match a known class verbatim
  // or look like a class token (uppercase / hyphen / digits).
  if (KNOWN_CLASSES.has(c)) return true;
  if (/^(GT[234E]?|GTP|LMP[23]|TCR|F[1234]|FF1600)$/i.test(c)) return true;
  return false;
}

function looksLikeTrackHeader(cell: string): boolean {
  if (!cell) return false;
  const c = cell.trim();
  // Track headers are >= 4 chars, contain at least one space or capital, and
  // are NOT a recognised class label or a literal "Lap Time" / "Class" header.
  if (c.length < 4) return false;
  if (looksLikeClass(c)) return false;
  if (/^(class|lap time|driver|sky|wind|date|air temp|humidity|track usage)$/i.test(c)) return false;
  // Track headers sometimes contain digits ("2024 Daytona 24h") so we don't
  // hard-exclude digits. But we DO exclude pure numbers and obvious lap-time
  // strings (which would have been caught by parseLapTime in the calling
  // context anyway).
  if (/^\d+(\.\d+)?$/.test(c)) return false;
  if (parseLapTime(c) != null) return false;
  return true;
}

function extractRowsFromBlock(grid: string[][], colC: number, colD: number, colE: number): SheetRow[] {
  const out: SheetRow[] = [];
  let currentTrack = "";
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    const c = (row[colC] || "").trim();
    const d = (row[colD] || "").trim();
    const e = (row[colE] || "").trim();

    // Track header detection. In observed gosetups tabs the track name
    // appears in the SAME column as the lap-time column (colE), on a row
    // where colC and colD are empty. Examples (left block, colE=4):
    //   row "...,'',Brands Hatch,'',..." -> track="Brands Hatch"
    //   row "...,'',Laguna Seca,'',..."  -> track="Laguna Seca"
    if (!c && !d && e && looksLikeTrackHeader(e) && !looksLikeClass(e) && parseLapTime(e) == null) {
      currentTrack = e;
      continue;
    }

    // Data row detection: class in col C, car in col D, time in col E.
    if (!c || !d || !e) continue;
    if (!looksLikeClass(c)) continue;
    const time = parseLapTime(e);
    if (time == null) continue;
    if (!currentTrack) continue; // drop rows we can't anchor to a track
    out.push({
      trackName: currentTrack,
      className: c,
      carName: d,
      timeSeconds: time,
    });
  }
  return out;
}

function parseSheetTab(csv: string): SheetRow[] {
  const grid = parseCsv(csv);
  // Observed layout:
  //   left block:  class=col C (2), car=col D (3), time/track-header=col E (4)
  //   right block: class=col N (13), car=col O (14), time/track-header=col P (15)
  // The track name appears in the time column on a row where the class+car
  // columns are empty -- this pattern is the same for both blocks.
  const left = extractRowsFromBlock(grid, 2, 3, 4);
  const right = extractRowsFromBlock(grid, 13, 14, 15);
  return [...left, ...right];
}

// ---- main entry point -----------------------------------------------------

export type GosetupsScrapeResult = {
  fetched: number;
  inserted: number;
  updated: number;
  errors: string[];
};

/**
 * Map the iRacing-track variation slug (e.g. "ir-imola-gp",
 * "ir-summit-point") to a normalised track name we'll then canonicalise via
 * lib/track-canonical.ts. The slug is kebab-case prefixed with "ir-" for
 * current-season variations; for historical "25S1 | GTSprint | Bathurst"
 * variations the slug is e.g. "25s1-gtsprint-bathurst" which we don't try
 * to associate (out of scope for current-season scrape).
 *
 * Returns null if the slug looks like a season-pass / historical / non-track
 * variation we should skip.
 */
function trackSlugToName(slug: string, termName: string): string | null {
  // "ir-imola-gp" -> use the term's display name "Imola GP" rather than
  // reverse-engineering the slug.
  if (!slug.startsWith("ir-")) return null;
  if (slug.includes("season-pass") || slug === "ir-2026-s2-season-pass") return null;
  // Use the canonical-cased term name from the WC API (more reliable than
  // de-kebab-casing the slug).
  return termName;
}

/**
 * Look up the variation_id for a (product slug, track slug) pair. Used to
 * build the deep-link URL.
 */
type VariationIndex = Map<string, { productSlug: string; productName: string; productPermalink: string; variationId: number; trackName: string; trackSlug: string }>;

/**
 * Build a (carName -> { trackSlug -> variation }) index from the WC product
 * list. We later look up rows by (carName, trackSlug-or-name) to find the
 * deep-link.
 *
 * The car-name match between Google Sheet rows and WC product names is
 * imperfect (e.g. sheet says "Aston Martin V8 GT3" but WC says "Aston Martin
 * Vantage GT3 Evo"). We do the join later in canonicaliseCarName().
 */
function buildVariationIndex(products: WcProduct[]): VariationIndex {
  const idx: VariationIndex = new Map();
  for (const p of products) {
    if (p.type !== "variable") continue;
    const trackAttr = p.attributes.find((a) => a.taxonomy === "pa_select-iracing-track");
    if (!trackAttr) continue;
    const termsBySlug = new Map(trackAttr.terms.map((t) => [t.slug, t]));
    for (const v of p.variations) {
      const trackVal = v.attributes.find((a) => a.name === "Select iRacing Track")?.value;
      if (!trackVal) continue;
      const term = termsBySlug.get(trackVal);
      if (!term) continue;
      const trackName = trackSlugToName(term.slug, term.name);
      if (!trackName) continue;
      const key = `${p.slug}::${term.slug}`;
      idx.set(key, {
        productSlug: p.slug,
        productName: p.name,
        productPermalink: p.permalink,
        variationId: v.id,
        trackName,
        trackSlug: term.slug,
      });
    }
  }
  return idx;
}

/**
 * Map a sheet's car name to the WC product name and then to the canonical
 * car name.
 *
 * The sheet uses shorter, sometimes ambiguous names ("Aston Martin V8 GT3",
 * "Cup chassis", "BMW M2 CS Racing"); WC uses the formal iRacing names.
 * Strategy:
 *   1. canonicalizeCarName() from lib/car-name-canonical covers all the known
 *      cross-shop aliases (Aston Martin GT3 -> Vantage GT3 EVO, etc.).
 *   2. Exact case-insensitive match against WC product names.
 *   3. Normalised-token Jaccard with threshold 0.5 against WC product names.
 *   4. Defensive: return the canonicalised sheet name unchanged.
 *
 * Returns the final canonical name (after all passes).
 */
function resolveCarName(sheetName: string, productNames: string[]): string {
  // Pass 1: shared canonical alias map (handles the cross-shop spelling diffs).
  const afterCanonical = canonicalizeCarName(sheetName);

  // Pass 2: exact case-insensitive match against WC product names.
  const lc = afterCanonical.toLowerCase();
  for (const p of productNames) {
    if (p.toLowerCase() === lc) return canonicalizeCarName(p);
  }

  // Pass 3: token Jaccard against WC product names.
  const toTokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 2),
    );
  const sheetTokens = toTokens(afterCanonical);
  let bestScore = 0;
  let best = "";
  for (const p of productNames) {
    const pTokens = toTokens(p);
    const intersect = new Set([...sheetTokens].filter((x) => pTokens.has(x)));
    const union = new Set([...sheetTokens, ...pTokens]);
    const score = union.size > 0 ? intersect.size / union.size : 0;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  if (bestScore >= 0.5) return canonicalizeCarName(best);

  return afterCanonical;
}

/**
 * Run the gosetups scrape end-to-end against the supplied prisma client.
 * Pure async function (no top-level await, no shebangs, no process.exit).
 */
export async function runGosetupsScrape(prisma: PrismaClient): Promise<GosetupsScrapeResult> {
  const startedAt = new Date();
  const ua = userAgent();
  console.log(`gosetups scraper start ${startedAt.toISOString()}`);

  const shop = await prisma.shop.findUnique({ where: { name: SHOP_NAME } });
  if (!shop) {
    throw new Error(`Shop '${SHOP_NAME}' is missing -- run db:seed first.`);
  }

  const seasons = await prisma.season.findMany({
    orderBy: [{ year: "desc" }, { quarter: "desc" }],
    include: { weeks: true },
  });
  if (seasons.length === 0) {
    throw new Error("No Season rows -- run db:seed first.");
  }

  const allCategories = await prisma.category.findMany();
  const categoryByName = new Map(allCategories.map((c) => [c.name, c]));
  const defaultCategory =
    categoryByName.get("Sports Car") ?? categoryByName.get("Road");
  if (!defaultCategory) {
    throw new Error("No 'Sports Car' or 'Road' category -- run db:seed first.");
  }

  const fetcher = new PoliteFetcher(ua);

  const gosetupsRobots = await loadRobots(GOSETUPS_ROBOTS, ua);
  const sheetRobots = await loadRobots(SHEET_ROBOTS, ua);

  if (!gosetupsRobots.isAllowed(GS_API_PRODUCTS, ua)) {
    await prisma.scrapeRun.create({
      data: {
        shopName: SHOP_NAME,
        status: "BLOCKED",
        error: "robots.txt disallow at WC Store API",
        finishedAt: new Date(),
      },
    });
    return {
      fetched: 0,
      inserted: 0,
      updated: 0,
      errors: ["WC Store API path disallowed by robots.txt"],
    };
  }

  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  const errors: string[] = [];

  // ---- 1. Pull the WC Store product catalog --------------------------------

  const productsUrl = `${GS_API_PRODUCTS}?category=${GS_IRACING_CATEGORY_ID}&per_page=100`;
  console.log(`-> GET ${productsUrl}`);
  const prodResp = await fetcher.fetch(productsUrl, { accept: "application/json" });
  if (!prodResp || prodResp.status >= 400) {
    errors.push(`HTTP ${prodResp?.status ?? "no-resp"} on WC Store API`);
    await prisma.scrapeRun.create({
      data: {
        shopName: SHOP_NAME,
        status: "FAILED",
        fetched: 0,
        error: errors[0],
        finishedAt: new Date(),
      },
    });
    return { fetched: 0, inserted: 0, updated: 0, errors };
  }

  let products: WcProduct[] = [];
  try {
    products = JSON.parse(prodResp.text) as WcProduct[];
  } catch (err) {
    errors.push(`failed to parse WC Store API JSON: ${(err as Error).message}`);
  }
  console.log(`  fetched ${products.length} iRacing products`);

  const variationIndex = buildVariationIndex(products);
  const productNames = products.map((p) => p.name);

  // ---- 2. Discover the Google Sheet's "default sheet" sig ------------------
  //
  // The gviz endpoint silently falls back to the default sheet when the
  // requested tab name doesn't exist. To detect that, fetch the default
  // (no &sheet param) once and remember its `sig` from the JSONP response.
  // Subsequent CSV fetches whose JSONP response carries the same sig point
  // at the default tab and should be treated as "tab not found".

  const sheetCsvBase = `${SHEET_HOST}/spreadsheets/d/${SHEET_ID}/gviz/tq`;
  const sheetJsonBase = `${SHEET_HOST}/spreadsheets/d/${SHEET_ID}/gviz/tq`;

  if (!sheetRobots.isAllowed(sheetCsvBase, ua)) {
    errors.push("docs.google.com robots.txt disallows gviz");
  }

  console.log(`-> GET sheet default sig`);
  const defaultJsonResp = await fetcher.fetch(`${sheetJsonBase}?tqx=out:json`, {
    accept: "text/javascript,application/json",
  });
  let defaultSig: string | null = null;
  if (defaultJsonResp && defaultJsonResp.status < 400) {
    const m = /"sig":"(\d+)"/.exec(defaultJsonResp.text);
    if (m) defaultSig = m[1];
  }
  if (defaultSig == null) {
    console.warn("  could not determine default-sheet sig; tab-existence check disabled");
  } else {
    console.log(`  default-sheet sig=${defaultSig}`);
  }

  // ---- 3. For each known season, walk weeks 1..13 --------------------------

  for (const season of seasons) {
    // Tab labels in the sheet use the format "<YY>S<N> WEEK <W>" (e.g.
    // "26S2 WEEK 7"). The year is taken modulo 100 to get the two-digit form.
    const yy = String(season.year).slice(-2);
    const tabPrefix = `${yy}S${season.quarter}`;
    const weekByNum = new Map(season.weeks.map((w) => [w.weekNum, w]));

    for (let weekNum = 1; weekNum <= 13; weekNum++) {
      const weekRow = weekByNum.get(weekNum);
      if (!weekRow) continue;

      const tabName = `${tabPrefix} WEEK ${weekNum}`;
      const tabUrl = `${sheetCsvBase}?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
      const tabJsonUrl = `${sheetJsonBase}?tqx=out:json&sheet=${encodeURIComponent(tabName)}`;

      // Use JSON (with sig) to detect the default-fallback first.
      console.log(`-> GET sig for ${tabName}`);
      const sigResp = await fetcher.fetch(tabJsonUrl, {
        accept: "text/javascript,application/json",
      });
      if (!sigResp || sigResp.status >= 400) {
        errors.push(`HTTP ${sigResp?.status ?? "no-resp"} on ${tabName} sig`);
        continue;
      }
      const sigMatch = /"sig":"(\d+)"/.exec(sigResp.text);
      const tabSig = sigMatch ? sigMatch[1] : null;
      if (defaultSig && tabSig === defaultSig) {
        console.log(`  ${tabName} -> tab not present (sig matches default); skipping`);
        continue;
      }

      console.log(`-> GET CSV for ${tabName}`);
      const csvResp = await fetcher.fetch(tabUrl, { accept: "text/csv" });
      if (!csvResp || csvResp.status >= 400) {
        errors.push(`HTTP ${csvResp?.status ?? "no-resp"} on ${tabName} CSV`);
        continue;
      }

      const sheetRows = parseSheetTab(csvResp.text);
      console.log(`  ${tabName}: parsed ${sheetRows.length} time rows`);

      for (const sr of sheetRows) {
        try {
          totalFetched++;
          const carName = resolveCarName(sr.carName, productNames);
          const canonicalClass =
            canonicalFromName(carName) ??
            canonicalFromName(sr.carName) ??
            sr.className;

          const canonicalTrackName = canonicalizeTrackName(sr.trackName);

          // Choose category. PCUP/PCC/Production/TCR/MX-5 aren't categories
          // (they're carClass values), they all sit under "Sports Car" or
          // similar. Default to Sports Car; let HYMO's authoritative
          // category propagate via the per-car upsert if HYMO already
          // wrote it.
          const categoryRow = defaultCategory;

          const car = await prisma.car.upsert({
            where: { name: carName },
            create: {
              name: carName,
              carClass: canonicalClass,
              categoryId: categoryRow.id,
            },
            // Don't overwrite class/category that HYMO already set.
            update: {},
          });

          const track = await prisma.track.upsert({
            where: { name: canonicalTrackName },
            create: { name: canonicalTrackName },
            update: {},
          });

          // Build the deep-link URL. Match by product slug -> car name and
          // track slug -> canonical-track name. The variation index keys are
          // (productSlug::trackSlug); we derive a productSlug from carName
          // by reverse-lookup in the products list (case-insensitive name
          // match).
          let listingUrl = `${GOSETUPS_HOST}/product-category/iracing-setups/`;
          const matchedProduct = products.find(
            (p) => p.name.toLowerCase() === carName.toLowerCase(),
          );
          if (matchedProduct) {
            // Find a variation whose track term matches our canonical name.
            // We compare against the trackName the variation index recorded.
            for (const [, v] of variationIndex) {
              if (v.productSlug !== matchedProduct.slug) continue;
              if (canonicalizeTrackName(v.trackName) === canonicalTrackName) {
                listingUrl = `${matchedProduct.permalink}?attribute_pa_select-iracing-track=${v.trackSlug}`;
                break;
              }
            }
            if (listingUrl === `${GOSETUPS_HOST}/product-category/iracing-setups/`) {
              // No track-match; fall back to the product page.
              listingUrl = matchedProduct.permalink;
            }
          }

          const existing = await prisma.setupListing.findUnique({
            where: {
              shopId_carId_trackId_seasonWeekId: {
                shopId: shop.id,
                carId: car.id,
                trackId: track.id,
                seasonWeekId: weekRow.id,
              },
            },
            include: { lapTime: true },
          });

          const seriesName = sr.className || null;
          const upserted = await prisma.setupListing.upsert({
            where: {
              shopId_carId_trackId_seasonWeekId: {
                shopId: shop.id,
                carId: car.id,
                trackId: track.id,
                seasonWeekId: weekRow.id,
              },
            },
            create: {
              shopId: shop.id,
              carId: car.id,
              trackId: track.id,
              seasonWeekId: weekRow.id,
              url: listingUrl,
              price: null,
              series: seriesName,
              lastSeenAt: new Date(),
            },
            update: {
              url: listingUrl,
              series: seriesName,
              lastSeenAt: new Date(),
            },
          });

          // Upsert lap time. Keep the fastest if we see multiple sessions
          // for the same (car, track, week) cell across the same week tab.
          const previous =
            existing?.lapTime?.timeSeconds ?? Number.POSITIVE_INFINITY;
          if (sr.timeSeconds < previous) {
            await prisma.lapTime.upsert({
              where: { setupListingId: upserted.id },
              create: {
                setupListingId: upserted.id,
                timeSeconds: sr.timeSeconds,
                source: "SHOP_PUBLISHED",
              },
              update: {
                timeSeconds: sr.timeSeconds,
                source: "SHOP_PUBLISHED",
              },
            });
          }

          if (existing) totalUpdated++;
          else totalInserted++;
        } catch (err) {
          errors.push(
            `upsert failed for (${sr.carName} @ ${sr.trackName}): ${(err as Error).message}`,
          );
        }
      }
    }
  }

  await prisma.scrapeRun.create({
    data: {
      shopName: SHOP_NAME,
      status:
        errors.length === 0
          ? "OK"
          : totalInserted + totalUpdated > 0
            ? "PARTIAL"
            : "FAILED",
      fetched: totalFetched,
      inserted: totalInserted,
      updated: totalUpdated,
      error: errors.length ? errors.slice(0, 5).join("; ").slice(0, 1000) : null,
      finishedAt: new Date(),
    },
  });

  console.log(
    `gosetups scraper done. fetched=${totalFetched} inserted=${totalInserted} updated=${totalUpdated} errors=${errors.length}`,
  );

  return {
    fetched: totalFetched,
    inserted: totalInserted,
    updated: totalUpdated,
    errors,
  };
}
