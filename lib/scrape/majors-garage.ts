/**
 * majorsgarage.com scraper -- library entry point.
 *
 * Round 10. Majors Garage is a Bubble.io app behind Cloudflare. Their public
 * Data API exposes the `setup` object type (verified by `GET
 * https://majorsgarage.com/api/1.1/meta` -> `"get": ["setup"]`). All ~4200
 * setup rows are iRacing (the `sim` field is uniformly "iRacing"), and ~1300
 * are tagged for the current 2026 S2 season at probe time.
 *
 *   GET https://majorsgarage.com/api/1.1/obj/setup
 *     ?constraints=[{"key":"Year","constraint_type":"equals","value":2026},
 *                   {"key":"Season","constraint_type":"equals","value":"S2"}]
 *     &cursor=0&limit=100
 *
 * Returns:
 *   {
 *     response: {
 *       cursor: number, remaining: number, count: number,
 *       results: SetupRow[]
 *     }
 *   }
 *
 * The Data API does NOT expose `obj/car` or `obj/track` (probed: 404). Cars
 * and Tracks live as Bubble object IDs in the SetupRow, but we cannot resolve
 * those IDs to names. Instead, we parse the `Slug` field which is structured
 * as `<car-name>-<track-name>-YYYYsNwNN[-i]` (e.g.
 * `ferrari-296-gt3-silverstone-2026s2w07-1`). Slug parsing is lossy when the
 * car or track name contains hyphens (e.g. "BMW M-Hybrid LMDh" -> the slug
 * ambiguity gets resolved by anchoring on the year-season-week suffix and by
 * checking known-track names from the existing canonicalisation map).
 *
 * Lap times are stored in the `laptime` text field with WILDLY varied
 * formats (probed examples):
 *   "Q 29.557\nR 29.659"          (qual + race, sprint)
 *   "R 26.408\nQ 26.225"
 *   "Q 1.01.678\nR 1.02.322"      (note dot-separator format)
 *   "1:30,755"                    (single time, comma decimal)
 *   "lap 5: 01:30.688"            (annotated)
 *   "lap 5: "                     (empty string after annotation)
 *
 * Strategy:
 *   1. Page through `obj/setup` with constraints (Year, Season) for each
 *      Season we know about.
 *   2. For each row, parse `Slug` to recover (car-name, track-name).
 *   3. Use existing `lookupCanonicalClass(prisma, carName, fallback)` for
 *      class (HYMO is authoritative; we fall back to "Production" then to
 *      the row's Discipline-implied class).
 *   4. Use `canonicalizeTrackName(trackName)` for track normalisation.
 *   5. Parse `laptime` to seconds (fastest of qual/race when both present,
 *      since we want one cell per (shop, car, track, week)).
 *   6. Listing URL: `https://majorsgarage.com/setupview/<slug>` (verified
 *      via /sitemap-setupview.xml).
 *
 * Hard rules (audit parity with HYMO scraper):
 *   - Honor robots.txt (only /version-test/ is disallowed; setup API is fine).
 *   - Rate limit: 1 request per 5s with +/- 2s jitter on each external HTTP.
 *   - User-Agent identifies the bot + a contact email.
 *   - Retry 429/503 with exponential backoff (5s -> 10s -> 20s, 3 retries max).
 *   - Idempotent: re-running upserts only.
 */
import { fetch } from "undici";
import robotsParser from "robots-parser";
import type { PrismaClient } from "../../app/generated/prisma/client";
import { canonicalFromName, lookupCanonicalClass } from "../car-class-canonical";
import { canonicalizeTrackName } from "../track-canonical";
import { canonicalizeCarName } from "../car-name-canonical";

const SHOP_NAME = "Majors Garage";
const MAJORS_HOST = "https://majorsgarage.com";
const MAJORS_ROBOTS = `${MAJORS_HOST}/robots.txt`;
const MAJORS_API = `${MAJORS_HOST}/api/1.1/obj/setup`;

const RATE_LIMIT_MS = 5000;
const JITTER_MS = 2000;
const MAX_RETRIES = 3;
const PAGE_SIZE = 100; // Bubble caps `limit` at 100

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
    return robotsParser(robotsUrl, "");
  }
}

class PoliteFetcher {
  private lastFetchAt = 0;
  constructor(private ua: string) {}

  async fetch(url: string, attempt = 1): Promise<{ status: number; text: string } | null> {
    const wait = this.lastFetchAt === 0 ? 0 : jitteredDelay() - (Date.now() - this.lastFetchAt);
    if (wait > 0) await sleep(wait);
    this.lastFetchAt = Date.now();

    let res;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": this.ua,
          Accept: "application/json",
        },
      });
    } catch (err) {
      console.warn(`  fetch error on ${url}: ${(err as Error).message}`);
      if (attempt <= MAX_RETRIES) {
        const backoff = 5000 * Math.pow(2, attempt - 1);
        console.warn(`  retrying in ${backoff}ms (attempt ${attempt}/${MAX_RETRIES})`);
        await sleep(backoff);
        return this.fetch(url, attempt + 1);
      }
      return null;
    }

    if ((res.status === 429 || res.status === 503) && attempt <= MAX_RETRIES) {
      const backoff = 5000 * Math.pow(2, attempt - 1);
      console.warn(`  ${res.status} on ${url}; backing off ${backoff}ms (attempt ${attempt}/${MAX_RETRIES})`);
      await sleep(backoff);
      return this.fetch(url, attempt + 1);
    }

    const text = await res.text();
    if (!res.ok) {
      console.warn(`  HTTP ${res.status} on ${url}`);
      return { status: res.status, text };
    }
    return { status: res.status, text };
  }
}

// ---- Bubble Data API row shape -------------------------------------------

type SetupRow = {
  _id: string;
  Year?: number;
  Season?: string; // "S1" | "S2" | ...
  Week?: string; // "W01" | "W07"
  Discipline?: string; // "Road" | "Oval"
  Slug?: string;
  Car?: string; // bubble id, not name
  Track?: string; // bubble id, not name
  laptime?: string;
  "Setup Type"?: string;
  "Created Date"?: string;
  is_legacy?: boolean;
  sim?: string;
  "Event Name"?: string | null;
};

type SetupsResponse = {
  response: {
    cursor: number;
    remaining?: number;
    count?: number;
    results: SetupRow[];
  };
};

// ---- Slug parsing ---------------------------------------------------------

/**
 * Parse a Majors Garage setup slug into (carName, trackName).
 *
 * Slugs are structured as: `<car-slug>-<track-slug>-YYYYsNwNN[-i]`
 *
 * Algorithm:
 *   1. Strip the optional trailing "-<index>" (e.g. "-1", "-2", "-3").
 *   2. Strip the "-YYYYsNwNN" suffix.
 *   3. Walk a "known-tracks" prefix-match against the right edge: if any
 *      tail substring matches a normalised known track slug, that's the
 *      track; the rest is the car.
 *   4. Fallback: split at the LAST "-". Car is everything before; track is
 *      whatever's after. This is best-effort -- car/track names with
 *      hyphens may end up sliced. The downstream canonicalisation
 *      (canonicaliseCarName / canonicalizeTrackName) cleans up many of
 *      these via existing override maps.
 *
 * Returns { carName, trackName } strings (raw, before canonicalisation),
 * or null if the slug is unrecognisable.
 */

// Hand-maintained list of known iRacing track slugs as Majors Garage
// renders them in setup slugs. Sourced from the public sitemap-setupview.xml
// and from running the scraper once and inspecting bad parses. Tracks not
// in this list fall through to the fallback last-hyphen split, which the
// existing canonicalizeTrackName() then normalises.
const KNOWN_TRACK_SLUGS: string[] = [
  // Multi-word tracks first so the "longest-prefix-wins" sort keeps them
  // ahead of any shorter accidental matches.
  "barber-motorsports-park",
  "adelaide-street-circuit",
  "algarve-international-circuit",
  "circuit-of-the-americas",
  "silverstone-circuit-grand-prix",
  "silverstone-circuit",
  "sonoma-sportscar-alt",
  "sonoma-sportscar",
  "donington-national",
  "barber-full",
  "nords-24h-strecke",
  "phoenix",
  "portland-international-raceway",
  "sonoma",
  "interlagos",
  "suzuka",
  "monza",
  "road-america",
  "long-beach",
  "bathurst",
  "watkins-glen",
  "spa-francorchamps",
  "imola",
  "le-mans",
  "silverstone",
  "st-petersburg-grand-prix",
  "adelaide-street-circuit",
  "charlotte",
  "sebring",
  "summit-point",
  "vir",
  "darlington",
  "bristol",
  "homestead",
  "texas",
  "talladega",
  "atlanta",
  "kansas",
  "richmond",
  "las-vegas",
  "michigan",
  "fontana",
  "auto-club",
  "iowa",
  "pocono",
  "new-hampshire",
  "loudon",
  "gateway",
  "world-wide-technology-raceway",
  "world-wide-technology",
  "lucas-oil-indianapolis-raceway-park",
  "indianapolis-motor-speedway",
  "indianapolis",
  "indianapolis-grand-prix",
  "daytona",
  "daytona-road",
  "barber",
  "barber-motorsports-park",
  "road-atlanta",
  "mid-ohio",
  "lime-rock",
  "lime-rock-park",
  "okayama",
  "motegi",
  "fuji",
  "twin-ring-motegi",
  "tsukuba",
  "mosport",
  "canadian-tire-motorsport-park",
  "zolder",
  "oulton-park",
  "donington",
  "donington-park",
  "donington-gp",
  "brands-hatch",
  "snetterton",
  "magny-cours",
  "magny-cours-gp",
  "le-mans-bugatti",
  "nordschleife",
  "nurburgring",
  "nurburgring-combined",
  "nurburgring-gp",
  "hockenheim",
  "hockenheim-gp",
  "hockenheimring",
  "monza-gp",
  "monza-combined",
  "mugello",
  "mugello-gp",
  "vallelunga",
  "misano",
  "misano-gp",
  "imola-gp",
  "red-bull-ring",
  "red-bull-ring-gp",
  "salzburgring",
  "lausitz",
  "lausitzring",
  "zandvoort",
  "park-zandvoort",
  "circuit-zandvoort",
  "circuit-park-zandvoort",
  "okayama-full",
  "okayama-short",
  "fuji-gp",
  "suzuka-gp",
  "suzuka-east",
  "suzuka-west",
  "barcelona-gp",
  "jerez",
  "jerez-moto",
  "navarra",
  "navarra-long",
  "valencia",
  "ricardo-tormo",
  "circuit-ricardo-tormo",
  "algarve",
  "algarve-gp",
  "estoril",
  "circuito-estoril",
  "circuito-de-jerez",
  "circuito-de-navarra",
  "mexico-city",
  "mexico-city-gp",
  "miami",
  "miami-gp",
  "long-beach-grand-prix",
  "watkins-glen-classic",
  "watkins-glen-international",
  "watkins-glen-international-boot",
  "spa",
  "spa-gp",
  "spa-gp-2024",
  "iowa-speedway",
  "kansas-speedway",
  "atlanta-motor-speedway",
  "fontana-speedway",
  "michigan-international-speedway",
  "auto-club-speedway",
  "homestead-miami",
  "homestead-miami-speedway",
  "loudon-speedway",
  "new-hampshire-motor-speedway",
  "pocono-raceway",
  "talladega-superspeedway",
  "texas-motor-speedway",
  "darlington-raceway",
  "bristol-motor-speedway",
  "richmond-international-raceway",
  "richmond-raceway",
  "las-vegas-motor-speedway",
  "phoenix-raceway",
  "kentucky-speedway",
  "chicago-street-circuit",
  "chicagoland-speedway",
  "michigan-speedway",
  "the-bend-international",
  "the-bend",
  "tsukuba-circuit",
  "fuji-international-speedway",
  "fuji-international",
  "sachsenring",
  "okayama-international-circuit",
  "aragon",
  "motorland-aragon",
  "aragon-outer",
  "aragon-moto",
  "monza-historic",
  "monza-historic-1966",
  "spa-1966",
  "rouen-les-essarts",
  "norisring",
  "circuit-park-zolder",
  "tt-circuit-assen",
  "assen",
  "summit-point-motorsports-park",
  "summit-point-raceway",
  "lausitzring-grand-prix",
  "barcelona-catalunya",
  "barcelona",
  "circuit-de-barcelona-catalunya",
  "automotodrom-grobnik",
  "tsukuba-tt",
  // Round 10 additions surfaced by inspecting actual MG slugs:
  "rockingham",
  "martinsville",
  "oschersleben",
  "sonoma",
  "vir",
  "daytona-rcr",
  "barber-classic",
  // Round 10b -- short ovals + dirt tracks. These are mostly Majors-only;
  // the canonicaliser then maps them to formal names where possible.
  "north-wilkesboro",
  "port-royal",
  "southern-national",
  "slinger-speedway",
  "auto-club",
  "iowa",
  "lanier",
  "eldora",
  "kokomo",
  "limaland",
  "volusia",
  "fairbury",
  "lernerville",
  "knoxville",
  "weedsport",
  "wilkesboro",
  "millbridge",
  "hickory",
  "stafford",
  "thompson",
  "langley",
  "bullring",
  "fairgrounds",
  "coliseum",
  "winton",
  "north-boston",
  "south-boston",
  "boston",
  "lake-erie",
  "willow-springs",
  "homestead",
  "homestead-miami",
  "winchester",
  "salem",
  "lucas-oil-raceway",
  "irwindale",
  "iowa-speedway",
];

// Sort longest-first so prefix matches prefer the most specific track.
const KNOWN_TRACK_SLUGS_SORTED = [...new Set(KNOWN_TRACK_SLUGS)].sort(
  (a, b) => b.length - a.length,
);

/**
 * Convert a kebab-case slug to a Title Case display string.
 * "le-mans-24hrs" -> "Le Mans 24Hrs". This is what we feed to
 * canonicalizeTrackName(), which has the alias map for proper
 * normalisation.
 */
function unkebab(slug: string): string {
  return slug
    .split("-")
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

// canonicaliseCarName was the round-10 local helper. Round 13 replaced it
// with the shared canonicalizeCarName from lib/car-name-canonical.ts which
// covers all the same aliases plus the cross-shop spelling diffs surfaced
// by HYMO/GnG/gosetups/P1Doks. Call sites below use canonicalizeCarName.

function parseSlug(slug: string): { carName: string; trackName: string } | null {
  // 1. Strip optional "-<digit>" trailing index.
  let s = slug.replace(/-\d+$/, "");
  // 2. Strip the "YYYYsNwNN" suffix (and a possible leading hyphen).
  const ysw = s.replace(/-\d{4}s\dw\d{2}$/i, "");
  if (ysw === s) {
    // No season-week suffix -- not a setup slug we recognise.
    return null;
  }
  s = ysw;
  if (!s.includes("-")) return null;

  // 3. Try right-anchored prefix match against KNOWN_TRACK_SLUGS.
  for (const trackSlug of KNOWN_TRACK_SLUGS_SORTED) {
    if (s.endsWith("-" + trackSlug)) {
      const carSlug = s.slice(0, s.length - trackSlug.length - 1);
      if (carSlug.length === 0) continue;
      return {
        carName: unkebab(carSlug),
        trackName: unkebab(trackSlug),
      };
    }
  }

  // 4. Fallback: split at the LAST hyphen. Best-effort.
  const idx = s.lastIndexOf("-");
  if (idx <= 0) return null;
  const carSlug = s.slice(0, idx);
  const trackSlug = s.slice(idx + 1);
  if (!carSlug || !trackSlug) return null;
  return {
    carName: unkebab(carSlug),
    trackName: unkebab(trackSlug),
  };
}

// ---- laptime parsing ------------------------------------------------------

/**
 * Convert a Majors Garage `laptime` string (free-form text) to seconds.
 * Supports the multi-line "Q ...\nR ..." pattern and returns the FASTEST
 * recognised time across all lines.
 *
 * Recognised formats per line (after stripping leading qualifiers like
 * "Q ", "R: ", "lap 5: "):
 *   "M:SS.SSS"
 *   "MM:SS.SSS"
 *   "H:MM:SS.SSS"
 *   "SS.SSS"
 *   "M.SS.SSS"   (Majors uses dots between mm and ss sometimes: "1.01.678")
 *   "M:SS,SSS"   (comma decimal: "1:30,755")
 *
 * Returns null if no time was found.
 */
function parseMajorsLap(raw: string): number | null {
  if (!raw) return null;
  // Normalise comma decimals to dots ("1:30,755" -> "1:30.755") so the
  // regexes below treat them uniformly.
  const text = raw.replace(/(\d),(\d)/g, "$1.$2");
  let best = Number.POSITIVE_INFINITY;
  for (const lineRaw of text.split(/[\n\r]+/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    // First, look for "h:mm:ss.sss" (rare endurance) at any position.
    {
      const pat = /(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)/g;
      let m;
      while ((m = pat.exec(line)) !== null) {
        const a = parseInt(m[1], 10);
        const b = parseInt(m[2], 10);
        const c = parseFloat(m[3]);
        if (a >= 0 && a <= 23 && b >= 0 && b < 60 && c >= 0 && c < 60) {
          const secs = a * 3600 + b * 60 + c;
          if (secs > 5 && secs < 7200 && secs < best) best = secs;
        }
      }
    }
    // Then m.ss.sss / m:ss.sss / m:ss form.
    {
      const pat = /(?<![\d.])(\d{1,2})[.:](\d{2})\.(\d{2,4})(?![\d])/g;
      let m;
      while ((m = pat.exec(line)) !== null) {
        // Two interpretations:
        //   (a) "1:01.678" -> M:SS.SSS, capture 1=M, 2=SS, 3=SSS
        //   (b) "1.01.678" -> M.SS.SSS interpreted as M minutes + SS seconds + SSS ms
        // Both produce the same numerical seconds.
        const min = parseInt(m[1], 10);
        const ss = parseInt(m[2], 10);
        const frac = parseInt(m[3], 10);
        const fracDen = Math.pow(10, m[3].length);
        if (min >= 0 && min <= 60 && ss >= 0 && ss < 60) {
          const secs = min * 60 + ss + frac / fracDen;
          if (secs > 5 && secs < 7200 && secs < best) best = secs;
        }
      }
    }
    // m:ss form without fractional (e.g. "1:30")
    {
      const pat = /(?<![\d.])(\d{1,2}):(\d{2})(?![\d.])/g;
      let m;
      while ((m = pat.exec(line)) !== null) {
        const min = parseInt(m[1], 10);
        const ss = parseInt(m[2], 10);
        if (min >= 0 && min <= 60 && ss >= 0 && ss < 60) {
          const secs = min * 60 + ss;
          if (secs > 5 && secs < 7200 && secs < best) best = secs;
        }
      }
    }
    // ss.sss bare (e.g. "29.557") -- only when it's the entire token, not
    // part of a larger number.
    {
      const pat = /(?<![\d.:])(\d{1,3}\.\d{2,4})(?![\d.])/g;
      let m;
      while ((m = pat.exec(line)) !== null) {
        const secs = parseFloat(m[1]);
        if (secs > 5 && secs < 600 && secs < best) best = secs;
      }
    }
  }
  return best === Number.POSITIVE_INFINITY ? null : best;
}

/**
 * Parse a Bubble Week field ("W07") into the iRacing 1..13 integer.
 */
function parseWeek(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^W(\d{1,2})$/i.exec(raw.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n < 1 || n > 13) return null;
  return n;
}

/**
 * Parse a Bubble Season field ("S2") into the integer quarter.
 */
function parseSeason(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^S(\d)$/i.exec(raw.trim());
  if (!m) return null;
  return parseInt(m[1], 10);
}

// ---- main entry point -----------------------------------------------------

export type MajorsGarageScrapeResult = {
  fetched: number;
  inserted: number;
  updated: number;
  errors: string[];
};

/**
 * Run the Majors Garage scrape end-to-end against the supplied prisma client.
 * Pure async function: no top-level await, no shebangs, no process.exit.
 */
export async function runMajorsGarageScrape(prisma: PrismaClient): Promise<MajorsGarageScrapeResult> {
  const startedAt = new Date();
  const ua = userAgent();
  console.log(`Majors Garage scraper start ${startedAt.toISOString()}`);

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
  // Narrowing happens after the throw, so this is safe and TS can verify it.
  const ovalCategory = categoryByName.get("Oval") ?? defaultCategory;

  const fetcher = new PoliteFetcher(ua);

  const robots = await loadRobots(MAJORS_ROBOTS, ua);
  if (!robots.isAllowed(MAJORS_API, ua)) {
    await prisma.scrapeRun.create({
      data: {
        shopName: SHOP_NAME,
        status: "BLOCKED",
        error: "robots.txt disallows /api/1.1/obj/setup",
        finishedAt: new Date(),
      },
    });
    return {
      fetched: 0,
      inserted: 0,
      updated: 0,
      errors: ["Bubble Data API path disallowed by robots.txt"],
    };
  }

  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  const errors: string[] = [];

  // Iterate over each known season and pull all rows for it via cursor
  // pagination. The Bubble API caps `limit` at 100; cursor is the offset.
  for (const season of seasons) {
    const seasonStr = `S${season.quarter}`;
    const yearNum = season.year;
    const weekByNum = new Map(season.weeks.map((w) => [w.weekNum, w]));

    const constraints = [
      { key: "Year", constraint_type: "equals", value: yearNum },
      { key: "Season", constraint_type: "equals", value: seasonStr },
    ];
    const constraintsParam = encodeURIComponent(JSON.stringify(constraints));

    let cursor = 0;
    let pulled = 0;
    let totalForSeason = -1; // unknown until first response

    while (true) {
      const url = `${MAJORS_API}?constraints=${constraintsParam}&cursor=${cursor}&limit=${PAGE_SIZE}`;
      console.log(`-> GET season=${yearNum}/${seasonStr} cursor=${cursor}`);
      const resp = await fetcher.fetch(url);
      if (!resp || resp.status >= 400) {
        errors.push(`HTTP ${resp?.status ?? "no-resp"} on Bubble setup at cursor=${cursor}`);
        break;
      }
      let body: SetupsResponse;
      try {
        body = JSON.parse(resp.text) as SetupsResponse;
      } catch (err) {
        errors.push(`failed to parse Bubble JSON at cursor=${cursor}: ${(err as Error).message}`);
        break;
      }
      const rows = body.response?.results ?? [];
      const remaining = body.response?.remaining ?? 0;
      if (totalForSeason < 0) {
        // The Bubble docs say `count` is "rows in this batch"; `remaining`
        // is the count not yet returned. Total = rows + remaining.
        totalForSeason = rows.length + remaining;
        console.log(`  season=${yearNum}/${seasonStr} total rows reported: ${totalForSeason}`);
      }
      console.log(`  fetched ${rows.length} rows (cursor=${cursor}, remaining=${remaining})`);

      for (const row of rows) {
        try {
          totalFetched++;
          // Validate the row belongs to this season (defensive against any
          // server-side filter mishandling).
          if (row.Year !== yearNum) continue;
          if (parseSeason(row.Season) !== season.quarter) continue;
          if ((row.sim || "").toLowerCase() !== "iracing") continue;
          if (row.is_legacy === true) continue;

          const weekNum = parseWeek(row.Week);
          if (weekNum == null) continue;
          const weekRow = weekByNum.get(weekNum);
          if (!weekRow) continue;

          if (!row.Slug) continue;
          const parsed = parseSlug(row.Slug);
          if (!parsed) continue;

          const carName = canonicalizeCarName(parsed.carName);
          const trackNameRaw = parsed.trackName;
          const canonicalTrackName = canonicalizeTrackName(trackNameRaw);

          // Class lookup. HYMO/GnG should already have written canonical
          // classes; we defer to lookupCanonicalClass which checks the DB
          // first, then falls back to name-rule, then to a final fallback.
          const fallbackClass =
            canonicalFromName(carName) ??
            (row.Discipline === "Oval" ? "Oval" : "Production");
          const canonicalClass = await lookupCanonicalClass(
            prisma,
            carName,
            fallbackClass,
          );

          // Category. Oval discipline -> Oval category; otherwise defer to
          // Sports Car (HYMO will overwrite this on its next run if the car
          // is something else).
          const categoryRow =
            row.Discipline === "Oval" ? ovalCategory : defaultCategory;

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

          const listingUrl = `${MAJORS_HOST}/setupview/${row.Slug}`;
          const seriesName = row["Setup Type"] || row["Event Name"] || row.Discipline || null;

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

          // Lap time. Many rows have no laptime field; many that do are
          // unparseable noise. Skip silently when null.
          const incomingLap = parseMajorsLap(row.laptime ?? "");
          if (incomingLap != null) {
            const previous =
              existing?.lapTime?.timeSeconds ?? Number.POSITIVE_INFINITY;
            if (incomingLap < previous) {
              await prisma.lapTime.upsert({
                where: { setupListingId: upserted.id },
                create: {
                  setupListingId: upserted.id,
                  timeSeconds: incomingLap,
                  source: "SHOP_PUBLISHED",
                },
                update: {
                  timeSeconds: incomingLap,
                  source: "SHOP_PUBLISHED",
                },
              });
            }
          }

          if (existing) totalUpdated++;
          else totalInserted++;
        } catch (err) {
          errors.push(
            `upsert failed for slug=${row.Slug ?? row._id}: ${(err as Error).message}`,
          );
        }
      }

      pulled += rows.length;
      if (remaining <= 0 || rows.length === 0) break;
      cursor += rows.length;
    }
    console.log(`  season=${yearNum}/${seasonStr}: pulled=${pulled} (totalFetched=${totalFetched})`);
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
    `Majors Garage scraper done. fetched=${totalFetched} inserted=${totalInserted} updated=${totalUpdated} errors=${errors.length}`,
  );

  return {
    fetched: totalFetched,
    inserted: totalInserted,
    updated: totalUpdated,
    errors,
  };
}
