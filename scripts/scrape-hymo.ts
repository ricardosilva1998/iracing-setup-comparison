/**
 * HYMO Setups scraper.
 *
 * Round 2 rewrite: the public Next.js front-end at hymosetups.com hydrates
 * its catalog client-side from a Laravel JSON API at api.hymosetups.com.
 * The API is unauthenticated, public, robots.txt allows everything, and a
 * single POST returns 950+ setups with car / track / class / season / week /
 * lap_time. The earlier HTML-selector approach matched 0 cards because the
 * SSR HTML is empty until React hydrates.
 *
 * Endpoint:
 *   POST https://api.hymosetups.com/api/v1/products/search
 *   Body: {"category_id": 1}   // 1 = iRacing (vs ACC, LMU)
 *   Response: { status, message, data: { items: [...], count: N } }
 *
 * Each item has: id, name, category{id,name}, car_class{id,name},
 *   car{id,name,image_url}, track{id,name}, series{id,name},
 *   season{id,name,season_num,year}, member{id,name},
 *   lap_time ("MM:SS.mmm" string), lap_time_ms (number), year, week,
 *   description, weather, video_url, track_guide_url.
 *
 * HYMO's `week` field is an absolute index across seasons, not iRacing's
 * per-season Week 1..13. Each iRacing season runs ~14 weeks for HYMO
 * (Weeks 1..13 + a 13b rest week), so we map:
 *   iRacing weekNum = ((hymoWeek - 1) % 14) + 1, then clamp to <=13.
 *
 * Hard rules (audited by team-security):
 *   - Honor robots.txt for both www. and api. hosts.
 *   - Rate limit: 1 request per 5s with +/- 2s jitter.
 *   - User-Agent identifies the bot + a contact email.
 *   - Retry 429/503 with exponential backoff (5s -> 10s -> 20s, 3 retries max).
 *   - Idempotent: rerunning updates lastSeenAt, never duplicates rows.
 */
import "dotenv/config";
import { fetch } from "undici";
import robotsParser from "robots-parser";
import path from "path";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { canonicalFromHymoClass } from "../lib/car-class-canonical";

const HYMO_HOST = "https://www.hymosetups.com";
const HYMO_API_HOST = "https://api.hymosetups.com";
const ROBOTS_URL = `${HYMO_HOST}/robots.txt`;
const API_ROBOTS_URL = `${HYMO_API_HOST}/robots.txt`;
const CATEGORY_IRACING = 1; // confirmed via /api/v1/products/filters/cascading

const CONTACT_EMAIL =
  process.env.SCRAPER_CONTACT_EMAIL || "ricardomrbs1998@gmail.com";
const USER_AGENT = `iracing-setup-comparison/0.1 (+contact: ${CONTACT_EMAIL})`;

const RATE_LIMIT_MS = 5000;   // 5s base
const JITTER_MS = 2000;       // +/- 2s
const MAX_RETRIES = 3;

function getDbPath() {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  return path.resolve(process.cwd(), "dev.db");
}

const adapter = new PrismaBetterSqlite3({ url: `file:${getDbPath()}` });
const prisma = new PrismaClient({ adapter });

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredDelay() {
  const jitter = (Math.random() * 2 - 1) * JITTER_MS;
  return Math.max(1000, RATE_LIMIT_MS + jitter);
}

async function loadRobots(robotsUrl: string) {
  const res = await fetch(robotsUrl, {
    headers: { "User-Agent": USER_AGENT },
  });
  const body = res.ok ? await res.text() : "";
  return robotsParser(robotsUrl, body);
}

let lastFetchAt = 0;

type FetchOpts = { method?: "GET" | "POST"; body?: string; accept?: string };

async function politeFetch(url: string, opts: FetchOpts = {}, attempt = 1): Promise<{ status: number; text: string } | null> {
  // rate limit ----------------------------------------------------------
  const wait = lastFetchAt === 0 ? 0 : jitteredDelay() - (Date.now() - lastFetchAt);
  if (wait > 0) await sleep(wait);
  lastFetchAt = Date.now();

  const method = opts.method ?? "GET";
  const accept = opts.accept ?? "text/html,application/xhtml+xml";

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: accept,
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body,
    });
  } catch (err) {
    console.warn(`  fetch error on ${url}: ${(err as Error).message}`);
    return null;
  }

  // retry on 429/503 ----------------------------------------------------
  if ((res.status === 429 || res.status === 503) && attempt <= MAX_RETRIES) {
    const backoff = 5000 * Math.pow(2, attempt - 1);
    console.warn(`  ${res.status} on ${url}; backing off ${backoff}ms (attempt ${attempt}/${MAX_RETRIES})`);
    await sleep(backoff);
    return politeFetch(url, opts, attempt + 1);
  }

  const text = await res.text();
  if (!res.ok) {
    console.warn(`  HTTP ${res.status} on ${url}`);
    return { status: res.status, text };
  }
  return { status: res.status, text };
}

// ---- HYMO API types -----------------------------------------------------
type HymoProduct = {
  id: number;
  name: string;
  category: { id: number; name: string };
  car_class: { id: number; name: string };
  car: { id: number; name: string; image_url?: string };
  track: { id: number; name: string };
  series: { id: number; name: string };
  season: { id: number; name: string; season_num: number; year: number };
  member?: { id: number; name: string };
  lap_time: string;        // "MM:SS.mmm"
  lap_time_ms: number;
  year: number;
  week: number;            // continuous-index, NOT iRacing-week
  description?: string;
  video_url?: string | null;
  track_guide_url?: string | null;
};

type HymoSearchResponse = {
  status: boolean;
  message: string;
  data: { items: HymoProduct[]; count: number };
};

// HYMO uses an absolute week index across seasons (each iRacing season is
// 14 hymo-weeks: 13 race weeks + 1 rest week). Convert to iRacing week 1..13.
function toIRacingWeek(hymoWeek: number): number | null {
  const cycled = ((hymoWeek - 1) % 14) + 1; // 1..14
  if (cycled > 13) return null; // rest week, no real data
  return cycled;
}

// Map a HYMO car_class.name to (categoryName) we use in our DB.
// HYMO classes seen: GT3, GTP/LMDh, LMP2, LMP3, GTE, GT4, Single Seaters,
// TCR, PCUP, PCC, NASCAR Cup Series. All road / sports cars except
// Single Seaters which is Formula and NASCAR which is Oval.
function categoryForClass(carClassName: string): string {
  const c = carClassName.toUpperCase();
  if (c.includes("SINGLE SEATERS") || /^F[1234]\b/.test(c)) return "Formula";
  if (c.includes("NASCAR")) return "Oval";
  return "Sports Car";
}

async function main() {
  const startedAt = new Date();
  console.log(`HYMO scraper start ${startedAt.toISOString()}`);

  const shop = await prisma.shop.findUnique({ where: { name: "HYMO Setups" } });
  if (!shop) {
    throw new Error("Shop 'HYMO Setups' is missing -- run db:seed first.");
  }

  const seasons = await prisma.season.findMany({
    orderBy: [{ year: "desc" }, { quarter: "desc" }],
    include: { weeks: true },
  });
  if (seasons.length === 0) {
    throw new Error("No Season rows -- run db:seed first.");
  }
  // Index seasons by (year, quarter) for fast lookup against HYMO season payload.
  const seasonByYearQuarter = new Map(
    seasons.map((s) => [`${s.year}:${s.quarter}`, s]),
  );

  const allCategories = await prisma.category.findMany();
  const categoryByName = new Map(allCategories.map((c) => [c.name, c]));
  const defaultCategory = categoryByName.get("Sports Car") ?? categoryByName.get("Road");
  if (!defaultCategory) {
    throw new Error("No 'Sports Car' or 'Road' category -- run db:seed first.");
  }

  // robots.txt ---------------------------------------------------------
  const wwwRobots = await loadRobots(ROBOTS_URL);
  const apiRobots = await loadRobots(API_ROBOTS_URL);
  if (!apiRobots.isAllowed(`${HYMO_API_HOST}/`, USER_AGENT)) {
    console.error("api.hymosetups.com robots.txt disallows us. Aborting.");
    await prisma.scrapeRun.create({
      data: {
        shopName: "HYMO Setups",
        status: "BLOCKED",
        error: "robots.txt disallow at api host",
        finishedAt: new Date(),
      },
    });
    return;
  }
  // www. is consulted for transparency: we hit /setups/iracing once via
  // the public site so HYMO's analytics see a real visit before we
  // hammer the API. This mirrors how the real Next.js front-end behaves.
  if (!wwwRobots.isAllowed(`${HYMO_HOST}/setups/iracing`, USER_AGENT)) {
    console.warn("www robots.txt blocks /setups/iracing -- skipping the courtesy GET.");
  } else {
    console.log(`courtesy GET ${HYMO_HOST}/setups/iracing`);
    await politeFetch(`${HYMO_HOST}/setups/iracing`);
  }

  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  const errors: string[] = [];

  // ---- POST /api/v1/products/search?category_id=1 (iRacing) ----------
  const apiUrl = `${HYMO_API_HOST}/api/v1/products/search`;
  if (!apiRobots.isAllowed(apiUrl, USER_AGENT)) {
    errors.push(`robots.txt disallows ${apiUrl}`);
  } else {
    console.log(`-> POST ${apiUrl}`);
    const resp = await politeFetch(apiUrl, {
      method: "POST",
      body: JSON.stringify({ category_id: CATEGORY_IRACING }),
      accept: "application/json",
    });
    if (!resp || resp.status >= 400) {
      errors.push(`HTTP ${resp?.status ?? "no-resp"} on ${apiUrl}`);
    } else {
      let body: HymoSearchResponse | null = null;
      try {
        body = JSON.parse(resp.text) as HymoSearchResponse;
      } catch (err) {
        errors.push(`failed to parse JSON: ${(err as Error).message}`);
      }
      const items = body?.data?.items ?? [];
      console.log(`  fetched ${items.length} HYMO products (count=${body?.data?.count})`);
      totalFetched = items.length;

      for (const item of items) {
        try {
          // Resolve season -> SeasonWeek row.
          const seasonKey = `${item.season.year}:${item.season.season_num}`;
          const seasonRow = seasonByYearQuarter.get(seasonKey);
          if (!seasonRow) {
            // Item is from a season we haven't seeded; skip.
            continue;
          }
          const iRacingWeek = toIRacingWeek(item.week);
          if (iRacingWeek == null) continue; // rest week, no race data

          const weekRow = seasonRow.weeks.find((w) => w.weekNum === iRacingWeek);
          if (!weekRow) continue;

          // Resolve car / track / category.
          const categoryName = categoryForClass(item.car_class.name);
          const categoryRow = categoryByName.get(categoryName) ?? defaultCategory;

          // Canonical class for this car name -- HYMO's class is the
          // reference taxonomy. canonicalFromHymoClass() maps "Single Seaters"
          // -> "Formula" etc. and passes everything else through unchanged.
          const canonicalClass = canonicalFromHymoClass(item.car_class.name);

          // After round 3, Car is uniquely keyed by `name` alone. If a row
          // already exists (e.g. from a previous scraper run), update its
          // class to the canonical HYMO value -- HYMO is authoritative.
          const car = await prisma.car.upsert({
            where: { name: item.car.name },
            create: {
              name: item.car.name,
              carClass: canonicalClass,
              categoryId: categoryRow.id,
            },
            update: {
              carClass: canonicalClass,
              categoryId: categoryRow.id,
            },
          });

          const track = await prisma.track.upsert({
            where: { name: item.track.name },
            create: { name: item.track.name },
            update: {},
          });

          // The HYMO front-end renders product detail at
          // /setups/iracing/<car-slug>/<some-slug>. We don't get the URL
          // from the API but it embeds product `id` reliably; link to the
          // catalog page for now and refine if we ever see a slug field.
          const listingUrl = `${HYMO_HOST}/setups/iracing`;

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

          const seriesName = item.series?.name ?? null;

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

          // Lap time: HYMO publishes lap_time_ms (integer ms). Keep fastest.
          if (typeof item.lap_time_ms === "number" && item.lap_time_ms > 0) {
            const incoming = item.lap_time_ms / 1000;
            const previous = existing?.lapTime?.timeSeconds ?? Number.POSITIVE_INFINITY;
            if (incoming < previous) {
              await prisma.lapTime.upsert({
                where: { setupListingId: upserted.id },
                create: {
                  setupListingId: upserted.id,
                  timeSeconds: incoming,
                  source: "SHOP_PUBLISHED",
                },
                update: {
                  timeSeconds: incoming,
                  source: "SHOP_PUBLISHED",
                },
              });
            }
          }

          if (existing) totalUpdated++;
          else totalInserted++;
        } catch (err) {
          errors.push(`upsert failed for HYMO id ${item.id}: ${(err as Error).message}`);
        }
      }
    }
  }

  await prisma.scrapeRun.create({
    data: {
      shopName: "HYMO Setups",
      status: errors.length === 0 ? "OK" : (totalInserted + totalUpdated > 0 ? "PARTIAL" : "FAILED"),
      fetched: totalFetched,
      inserted: totalInserted,
      updated: totalUpdated,
      error: errors.length ? errors.slice(0, 5).join("; ") : null,
      finishedAt: new Date(),
    },
  });

  console.log(
    `\nHYMO scraper done. fetched=${totalFetched} inserted=${totalInserted} updated=${totalUpdated} errors=${errors.length}`,
  );
}

main()
  .catch((e) => {
    console.error("Scraper crashed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
