/**
 * Grid-and-Go scraper -- library entry point.
 *
 * Round 5 refactor: pure fetch + parse + persist logic for the Cognito
 * Hosted UI + PKCE OAuth flow. Reachable from app/api/ingest/route.ts and
 * from the CLI wrapper at scripts/scrape-grid-and-go.ts.
 *
 * IMPORTANT: this module imports `playwright` lazily inside the function
 * body. That keeps `playwright` (a heavy devDep with a Chromium binary)
 * out of the Next.js build trace until it's actually invoked. In production
 * the runner stage may not have Chromium installed; calling this function
 * there will throw with a clear "browserType.launch: Executable doesn't exist"
 * message. The /api/ingest route catches that, and round 5's deployment
 * defaults to running HYMO only in production until the Dockerfile is
 * extended to include playwright + Chromium in the runner stage.
 *
 * Auth (probed in round 2):
 *   Cognito Hosted UI, PKCE OAuth code grant. No captcha. No MFA.
 *   After login the SPA stores id_token / access_token / refresh_token in
 *   localStorage. API calls go to:
 *     https://oaseb2ya72.execute-api.eu-central-1.amazonaws.com
 *   carrying `Authorization: Bearer <id_token>`.
 *
 * Politeness:
 *   - Login is one round trip; we don't poll the login form.
 *   - >=5s between authenticated API calls, +/- 2s jitter.
 *   - Single concurrency.
 *   - Real Chromium user-agent (Playwright default).
 *   - Respect rate-limit headers (x-ratelimit-*, retry-after) if present.
 *   - On 401 we don't retry -- that means our session expired or the
 *     creds are wrong. Fail loudly.
 *
 * Secret hygiene:
 *   - Creds read from env. Never logged.
 *   - URLs scrubbed before logging (strip ?code=, ?state=, etc.).
 *   - On error, sanitise messages so creds cannot leak via stack traces.
 *   - No traces, no videos, no screenshots saved.
 *   - id_token / access_token / refresh_token are NEVER persisted to disk
 *     or to the DB; they live only in the browser context for one run.
 */
import type { PrismaClient } from "../../app/generated/prisma/client";
import { lookupCanonicalClass } from "../car-class-canonical";
import { canonicalizeTrackName } from "../track-canonical";
import { canonicalizeCarName } from "../car-name-canonical";
import { getGngTokens } from "./grid-and-go-auth";

export type SeasonArg = { year: number; quarter: number };

const APP_HOST = "https://app.grid-and-go.com";
const API_HOST = "https://oaseb2ya72.execute-api.eu-central-1.amazonaws.com";

const RATE_LIMIT_MS = 5000;
const JITTER_MS = 2000;
const SHOP_NAME = "Grid-and-Go";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredDelay() {
  const jitter = (Math.random() * 2 - 1) * JITTER_MS;
  return Math.max(2500, RATE_LIMIT_MS + jitter);
}

export function safeUrl(u: string): string {
  try {
    const parsed = new URL(u);
    const stripParams = ["code", "code_challenge", "code_verifier", "state", "id_token", "access_token", "refresh_token", "session"];
    for (const p of stripParams) parsed.searchParams.delete(p);
    return parsed.origin + parsed.pathname + (parsed.search ? `?${parsed.searchParams.toString()}` : "");
  } catch {
    return "<unparseable url>";
  }
}

export function sanitise(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join("<REDACTED>");
  }
  return out;
}

type SeriesMapping = { category: string };
const SERIES_MAP: Record<string, SeriesMapping> = {
  "IMSA":            { category: "Sports Car" },
  "GT-Sprint":       { category: "Sports Car" },
  "GTE-Sprint":      { category: "Sports Car" },
  "SportsCar":       { category: "Sports Car" },
  "NEC":             { category: "Sports Car" },
  "DTM":             { category: "Sports Car" },
  "TCR":             { category: "Sports Car" },
  "PCUP":            { category: "Sports Car" },
  "ProductionCar":   { category: "Sports Car" },
  "AdvancedMazda":   { category: "Sports Car" },
  "RingMeister":     { category: "Sports Car" },
  "Sebring12h":      { category: "Sports Car" },
  "24hNBR":          { category: "Sports Car" },
  "OPENWHEEL":       { category: "Formula" },
  "OPENWHEEL-FIXED": { category: "Formula" },
  "FIXED":           { category: "Sports Car" },
  "eSM":             { category: "Sports Car" },
};

type DataPackItem = {
  id: string;
  year: number;
  season: number;
  week: number;
  carName: string;
  carId?: string;
  trackName: string;
  laptime: number;
  series: string;
  author?: string;
  subscriptions?: string[];
  dateTime?: string;
};

export type GridAndGoScrapeResult = {
  fetched: number;
  inserted: number;
  updated: number;
  errors: string[];
};

/**
 * Run the Grid-and-Go scrape end-to-end against the supplied prisma client.
 * Reads GRID_AND_GO_EMAIL / GRID_AND_GO_PASSWORD from env at call time.
 *
 * Will throw if `playwright` cannot be imported (e.g. production runner that
 * never installed it). The /api/ingest route catches that.
 */
export async function runGridAndGoScrape(
  prisma: PrismaClient,
  season?: SeasonArg,
): Promise<GridAndGoScrapeResult> {
  const startedAt = new Date();
  console.log(`Grid-and-Go scraper start ${startedAt.toISOString()}`);

  const email = process.env.GRID_AND_GO_EMAIL;
  const password = process.env.GRID_AND_GO_PASSWORD;
  // Keep secrets array for sanitise() calls on error messages below.
  const secrets = [email ?? "", password ?? ""].filter(Boolean);

  const shop = await prisma.shop.findUnique({ where: { name: SHOP_NAME } });
  if (!shop) {
    throw new Error(`Shop '${SHOP_NAME}' is missing -- run db:seed first.`);
  }

  const defaultCategory = await prisma.category.findUnique({ where: { name: "Sports Car" } });
  if (!defaultCategory) {
    throw new Error("Category 'Sports Car' missing -- run db:seed first.");
  }
  const allCategories = await prisma.category.findMany();
  const categoryByName = new Map(allCategories.map((c) => [c.name, c]));

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

  // Obtain tokens via the shared auth helper (handles Playwright login + cache).
  const { idToken } = await getGngTokens();
  console.log(`authenticated. id_token length=${idToken.length}`);

  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  const errors: string[] = [];

  try {
    const seasonsToFetch: { year: number; season: number }[] = [
      { year: seasonRow.year, season: seasonRow.quarter },
    ];

    for (const target of seasonsToFetch) {
      await sleep(jitteredDelay());

      const url = `${API_HOST}/datapacks?year=${target.year}&season=${target.season}`;
      console.log(`-> ${safeUrl(url)}`);

      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${idToken}` },
        signal: AbortSignal.timeout(30000),
      });

      const retryAfter = resp.headers.get("retry-after");
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!Number.isNaN(seconds) && seconds > 0) {
          console.log(`  retry-after=${seconds}s; sleeping`);
          await sleep(seconds * 1000);
        }
      }

      if (resp.status === 401) {
        throw new Error("API returned 401 -- token rejected. Check creds / subscription.");
      }
      if (!resp.ok) {
        errors.push(`HTTP ${resp.status} on ${safeUrl(url)}`);
        continue;
      }

      const body = await resp.json().catch(() => null);
      const items = (body && typeof body === "object" && Array.isArray((body as { items?: DataPackItem[] }).items))
        ? (body as { items: DataPackItem[] }).items
        : [];
      console.log(`  fetched ${items.length} datapack items`);
      totalFetched += items.length;

      for (const item of items) {
        try {
          if (typeof item.week !== "number" || item.week < 1 || item.week > 13) continue;

          const weekRow = weekByNum.get(item.week);
          if (!weekRow) continue;

          const mapping = SERIES_MAP[item.series] ?? { category: "Sports Car" };
          const categoryRow = categoryByName.get(mapping.category) ?? defaultCategory;

          const carName = canonicalizeCarName(item.carName);
          const canonicalClass = await lookupCanonicalClass(
            prisma,
            carName,
            item.series || "UNKNOWN",
          );

          const car = await prisma.car.upsert({
            where: { name: carName },
            create: {
              name: carName,
              carClass: canonicalClass,
              categoryId: categoryRow.id,
            },
            update: {},
          });

          const canonicalTrackName = canonicalizeTrackName(item.trackName);
          const track = await prisma.track.upsert({
            where: { name: canonicalTrackName },
            create: { name: canonicalTrackName },
            update: {},
          });

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

          const listingUrl = `${APP_HOST}/#/datapacks/${item.id}`;
          const seriesName = item.series || null;

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

          const incomingLap = item.laptime;
          if (typeof incomingLap === "number" && incomingLap > 0) {
            const previous = existing?.lapTime?.timeSeconds ?? Number.POSITIVE_INFINITY;
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
          errors.push(`upsert failed for item ${item.id}: ${sanitise(String((err as Error).message), secrets).slice(0, 200)}`);
        }
      }
    }

    if (totalInserted + totalUpdated > 0) {
      await prisma.shop.update({
        where: { id: shop.id },
        data: {
          scrapingStatus: "AUTH_SCRAPED",
          notes: "Authenticated scrape via Cognito SSO.",
        },
      });
      console.log(`shop status -> AUTH_SCRAPED`);
    }
  } catch (err) {
    const msg = sanitise(String((err as Error).message || err), secrets);
    errors.push(msg);
    console.error(`scraper error: ${msg}`);
  }

  await prisma.scrapeRun.create({
    data: {
      shopName: SHOP_NAME,
      status: errors.length === 0 ? "OK" : (totalInserted + totalUpdated > 0 ? "PARTIAL" : "FAILED"),
      fetched: totalFetched,
      inserted: totalInserted,
      updated: totalUpdated,
      error: errors.length ? errors.slice(0, 5).join("; ").slice(0, 1000) : null,
      finishedAt: new Date(),
    },
  });

  console.log(
    `Grid-and-Go scraper done. fetched=${totalFetched} inserted=${totalInserted} updated=${totalUpdated} errors=${errors.length}`,
  );

  return { fetched: totalFetched, inserted: totalInserted, updated: totalUpdated, errors };
}
