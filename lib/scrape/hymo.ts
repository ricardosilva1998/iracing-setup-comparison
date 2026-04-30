/**
 * HYMO Setups scraper -- library entry point.
 *
 * Round 5 refactor: the pure fetch + parse + persist logic lives here so it
 * can be reached both by the CLI wrapper (scripts/scrape-hymo.ts) AND by the
 * production /api/ingest route (which Next.js standalone tracing follows from
 * app/ imports). Top-level side effects, dotenv import, and process.exit are
 * intentionally kept OUT of this module -- the caller controls those.
 *
 * Endpoint:
 *   POST https://api.hymosetups.com/api/v1/products/search
 *   Body: {"category_id": 1}   // 1 = iRacing (vs ACC, LMU)
 *   Response: { status, message, data: { items: [...], count: N } }
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
import { fetch } from "undici";
import robotsParser from "robots-parser";
import type { PrismaClient } from "../../app/generated/prisma/client";
import { canonicalFromHymoClass } from "../car-class-canonical";
import { canonicalizeTrackName } from "../track-canonical";
import { canonicalizeCarName } from "../car-name-canonical";

const HYMO_HOST = "https://www.hymosetups.com";
const HYMO_API_HOST = "https://api.hymosetups.com";
const ROBOTS_URL = `${HYMO_HOST}/robots.txt`;
const API_ROBOTS_URL = `${HYMO_API_HOST}/robots.txt`;
const CATEGORY_IRACING = 1;

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
  return Math.max(1000, RATE_LIMIT_MS + jitter);
}

async function loadRobots(robotsUrl: string, ua: string) {
  const res = await fetch(robotsUrl, { headers: { "User-Agent": ua } });
  const body = res.ok ? await res.text() : "";
  return robotsParser(robotsUrl, body);
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
  lap_time: string;
  lap_time_ms: number;
  year: number;
  week: number;
  description?: string;
  video_url?: string | null;
  track_guide_url?: string | null;
};

type HymoSearchResponse = {
  status: boolean;
  message: string;
  data: { items: HymoProduct[]; count: number };
};

function toIRacingWeek(hymoWeek: number): number | null {
  const cycled = ((hymoWeek - 1) % 14) + 1;
  if (cycled > 13) return null;
  return cycled;
}

function categoryForClass(carClassName: string): string {
  const c = carClassName.toUpperCase();
  if (c.includes("SINGLE SEATERS") || /^F[1234]\b/.test(c)) return "Formula";
  if (c.includes("NASCAR")) return "Oval";
  return "Sports Car";
}

export type HymoScrapeResult = {
  fetched: number;
  inserted: number;
  updated: number;
  errors: string[];
};

/**
 * Run the HYMO scrape end-to-end against the supplied prisma client.
 * Pure async function: no top-level await, no shebangs, no process.exit,
 * no import.meta. Caller is responsible for prisma connect/disconnect.
 */
export async function runHymoScrape(prisma: PrismaClient): Promise<HymoScrapeResult> {
  const startedAt = new Date();
  const ua = userAgent();
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
  const seasonByYearQuarter = new Map(
    seasons.map((s) => [`${s.year}:${s.quarter}`, s]),
  );

  const allCategories = await prisma.category.findMany();
  const categoryByName = new Map(allCategories.map((c) => [c.name, c]));
  const defaultCategory = categoryByName.get("Sports Car") ?? categoryByName.get("Road");
  if (!defaultCategory) {
    throw new Error("No 'Sports Car' or 'Road' category -- run db:seed first.");
  }

  const fetcher = new PoliteFetcher(ua);

  const wwwRobots = await loadRobots(ROBOTS_URL, ua);
  const apiRobots = await loadRobots(API_ROBOTS_URL, ua);
  if (!apiRobots.isAllowed(`${HYMO_API_HOST}/`, ua)) {
    await prisma.scrapeRun.create({
      data: {
        shopName: "HYMO Setups",
        status: "BLOCKED",
        error: "robots.txt disallow at api host",
        finishedAt: new Date(),
      },
    });
    return { fetched: 0, inserted: 0, updated: 0, errors: ["api host disallowed by robots.txt"] };
  }
  if (!wwwRobots.isAllowed(`${HYMO_HOST}/setups/iracing`, ua)) {
    console.warn("www robots.txt blocks /setups/iracing -- skipping the courtesy GET.");
  } else {
    console.log(`courtesy GET ${HYMO_HOST}/setups/iracing`);
    await fetcher.fetch(`${HYMO_HOST}/setups/iracing`);
  }

  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  const errors: string[] = [];

  const apiUrl = `${HYMO_API_HOST}/api/v1/products/search`;
  if (!apiRobots.isAllowed(apiUrl, ua)) {
    errors.push(`robots.txt disallows ${apiUrl}`);
  } else {
    console.log(`-> POST ${apiUrl}`);
    const resp = await fetcher.fetch(apiUrl, {
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
          const seasonKey = `${item.season.year}:${item.season.season_num}`;
          const seasonRow = seasonByYearQuarter.get(seasonKey);
          if (!seasonRow) continue;

          const iRacingWeek = toIRacingWeek(item.week);
          if (iRacingWeek == null) continue;

          const weekRow = seasonRow.weeks.find((w) => w.weekNum === iRacingWeek);
          if (!weekRow) continue;

          const categoryName = categoryForClass(item.car_class.name);
          const categoryRow = categoryByName.get(categoryName) ?? defaultCategory;

          const canonicalClass = canonicalFromHymoClass(item.car_class.name);
          const carName = canonicalizeCarName(item.car.name);

          const car = await prisma.car.upsert({
            where: { name: carName },
            create: {
              name: carName,
              carClass: canonicalClass,
              categoryId: categoryRow.id,
            },
            update: {
              carClass: canonicalClass,
              categoryId: categoryRow.id,
            },
          });

          const canonicalTrackName = canonicalizeTrackName(item.track.name);
          const track = await prisma.track.upsert({
            where: { name: canonicalTrackName },
            create: { name: canonicalTrackName },
            update: {},
          });

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
    `HYMO scraper done. fetched=${totalFetched} inserted=${totalInserted} updated=${totalUpdated} errors=${errors.length}`,
  );

  return { fetched: totalFetched, inserted: totalInserted, updated: totalUpdated, errors };
}
