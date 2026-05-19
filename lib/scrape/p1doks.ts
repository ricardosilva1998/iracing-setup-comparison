/**
 * P1Doks scraper -- library entry point.
 *
 * Round 11. Reachable from app/api/ingest/route.ts and from the CLI wrapper at
 * scripts/scrape-p1doks.ts.
 *
 * AUTH FINDING (round 11 probe):
 *   The SPA at https://p1doks.com uses AWS Cognito (ca-central-1, client
 *   6mu7svlaa4q8i1mvkeknhsruo8) -- no MFA, no captcha. Tokens land in
 *   localStorage under CognitoIdentityServiceProvider.<clientId>.<userId>.{id,access,refresh}Token.
 *
 *   HOWEVER -- the actual catalog endpoint POST https://api.p1doks.com/ql/data-packs
 *   is PUBLIC. The SPA does NOT send an Authorization header on it (verified by
 *   intercepting the live request: only content-type/accept/referer headers are sent).
 *   The 401s seen in the round-1 audit were on /api/setups, /api/products,
 *   /api/telemetry/sessions/for-picker -- guesses that don't actually exist.
 *
 *   Per-user endpoints (subscription-status, ownerships) DO require Bearer idToken,
 *   but we don't need them for the comparison product premise.
 *
 *   THEREFORE this scraper deliberately uses plain undici fetch (no Playwright,
 *   no Cognito login) to hit /ql/data-packs. This is:
 *     - safer (no creds in flight)
 *     - politer (no headless browser to maintain in production)
 *     - faster (~5s vs ~60s GnG)
 *     - more faithful to how the SPA actually fetches the catalog
 *
 *   Although P1DOKS_EMAIL / P1DOKS_PASSWORD are in .env (and on Railway), this
 *   scraper does NOT consume them. They remain available for a future revisit
 *   if P1Doks ever closes the public path. The Shop.scrapingStatus is still
 *   set to AUTH_SCRAPED for UI consistency with GnG (and because it accurately
 *   describes the protected per-user data we *would* need creds for if we ever
 *   surfaced subscription-tier setups).
 *
 * Endpoint:
 *   POST https://api.p1doks.com/ql/data-packs
 *   Body: { limit, offset, filters: { Year: { _eq: "YYYY" }, Season: { _eq: "N" } },
 *           sort: ["lap_minutes","lap_seconds","lap_hundredths"] }
 *   Response: { data_pack: [...], data_pack_aggregated: [{ count: { id: N } }] }
 *
 *   Each data_pack item:
 *     { id: <uuid>, Year, Season, Week (1..13), Series (string),
 *       Track (string), Car (string), creator, price (cents),
 *       lap_minutes, lap_seconds, lap_hundredths (string), lap_time_formatted,
 *       date_updated, weather_datetime, wet_or_dry, ... }
 *
 *   Listing detail URL: https://p1doks.com/data-pack/<id>
 *
 * Politeness:
 *   - Robots.txt: not enforced for api.p1doks.com because the host has no
 *     robots.txt and is a JSON-only API consumed by the SPA. Mirrors HYMO's
 *     api.hymosetups.com handling.
 *   - >=3s between paginated POSTs, +/- 1s jitter.
 *   - Single concurrency.
 *   - User-Agent identifies the bot + contact email (same as HYMO).
 *   - Retry 429/503/network-error with exponential backoff (5s/10s/20s, 3 retries max).
 *   - On 401 we don't retry -- if the public path silently flips to gated, fail loudly.
 *
 * Secret hygiene:
 *   - No creds consumed by this scraper.
 *
 * Idempotent: composite-key upsert on SetupListing (shopId, carId, trackId,
 * seasonWeekId) collapses multiple datapacks per (car, track, week) into one
 * row, keeping the fastest LapTime.
 */
import { fetch } from "undici";
import type { PrismaClient } from "../../app/generated/prisma/client";
import { lookupCanonicalClass } from "../car-class-canonical";
import { canonicalizeTrackName } from "../track-canonical";
import { canonicalizeCarName } from "../car-name-canonical";

const API_HOST = "https://api.p1doks.com";
const SITE_HOST = "https://p1doks.com";
const SHOP_NAME = "P1Doks";

const RATE_LIMIT_MS = 3000;
const JITTER_MS = 1000;
const MAX_RETRIES = 3;
const PAGE_SIZE = 100;

function userAgent(): string {
  const contact = process.env.SCRAPER_CONTACT_EMAIL || "ricardomrbs1998@gmail.com";
  return `iracing-setup-comparison/0.1 (+contact: ${contact})`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredDelay() {
  const jitter = (Math.random() * 2 - 1) * JITTER_MS;
  return Math.max(1500, RATE_LIMIT_MS + jitter);
}

/**
 * Map P1Doks's `Series` string to one of our Category names. P1Doks's series
 * column is the iRacing series the datapack targets. Unknown series default
 * to "Sports Car" so we never silently drop a row.
 */
function categoryForSeries(series: string): string {
  if (!series) return "Sports Car";
  const s = series.toLowerCase();
  if (s.includes("dirt")) return "Dirt Road";
  if (s.includes("nascar") || s.includes("modified") || s.includes("late model") || s.includes("supercars")) return "Oval";
  if (
    s.includes("indycar") ||
    s.includes("indy nxt") ||
    s.includes("formula") ||
    s.includes("f1") ||
    s.includes("f3") ||
    s.includes("f4") ||
    s.includes("openwheel") ||
    s.includes("open wheel") ||
    s.includes("grand prix")
  ) {
    return "Formula";
  }
  return "Sports Car";
}

type P1DoksDataPack = {
  id: string;
  Year: number;
  Season: number;
  Series: string;
  Week: number;
  Track: string;
  Car: string;
  creator?: string;
  price?: number;
  lap_minutes?: number;
  lap_seconds?: number;
  lap_hundredths?: string | number;
  lap_time_formatted?: string;
  weather_datetime?: string;
  date_updated?: string;
};

type P1DoksResponse = {
  data_pack?: P1DoksDataPack[];
  data_pack_aggregated?: Array<{ count?: { id?: number } }>;
};

class PoliteFetcher {
  private lastFetchAt = 0;
  constructor(private ua: string) {}

  async post<T = unknown>(url: string, body: unknown, attempt = 1): Promise<{ status: number; json: T | null }> {
    const wait = this.lastFetchAt === 0 ? 0 : jitteredDelay() - (Date.now() - this.lastFetchAt);
    if (wait > 0) await sleep(wait);
    this.lastFetchAt = Date.now();

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": this.ua,
          "Content-Type": "application/json",
          Accept: "application/json",
          Referer: `${SITE_HOST}/`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt <= MAX_RETRIES) {
        const backoff = 5000 * Math.pow(2, attempt - 1);
        console.warn(
          `  network error on ${url}: ${(err as Error).message}; backing off ${backoff}ms (attempt ${attempt}/${MAX_RETRIES})`,
        );
        await sleep(backoff);
        return this.post(url, body, attempt + 1);
      }
      return { status: 0, json: null };
    }

    if ((res.status === 429 || res.status === 503) && attempt <= MAX_RETRIES) {
      const backoff = 5000 * Math.pow(2, attempt - 1);
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter ? Math.max(parseInt(retryAfter, 10) * 1000, backoff) : backoff;
      console.warn(`  ${res.status} on ${url}; backing off ${waitMs}ms (attempt ${attempt}/${MAX_RETRIES})`);
      await sleep(waitMs);
      return this.post(url, body, attempt + 1);
    }

    if (res.status === 401) {
      const text = await res.text().catch(() => "");
      throw new Error(`API returned 401 on ${url}: ${text.slice(0, 200)}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`  HTTP ${res.status} on ${url}: ${text.slice(0, 200)}`);
      return { status: res.status, json: null };
    }

    const json = await res.json().catch(() => null);
    return { status: res.status, json: json as T | null };
  }
}

export type P1DoksScrapeResult = {
  fetched: number;
  inserted: number;
  updated: number;
  errors: string[];
};

/**
 * Run the P1Doks scrape end-to-end against the supplied prisma client.
 * Pure async function. Caller is responsible for prisma connect/disconnect.
 */
export type SeasonArg = { year: number; quarter: number };

export async function runP1DoksScrape(
  prisma: PrismaClient,
  season?: SeasonArg,
): Promise<P1DoksScrapeResult> {
  const startedAt = new Date();
  console.log(`P1Doks scraper start ${startedAt.toISOString()}`);

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

  const fetcher = new PoliteFetcher(userAgent());

  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  const errors: string[] = [];

  const baseUrl = `${API_HOST}/ql/data-packs`;
  const target = { year: seasonRow.year, seasonNum: seasonRow.quarter };

  let offset = 0;
  let totalAvailable: number | null = null;

  try {
    while (true) {
      const body = {
        limit: PAGE_SIZE,
        offset,
        filters: {
          Year: { _eq: String(target.year) },
          Season: { _eq: String(target.seasonNum) },
        },
        sort: ["lap_minutes", "lap_seconds", "lap_hundredths"],
      };

      console.log(`-> POST ${baseUrl} offset=${offset} limit=${PAGE_SIZE}`);
      const resp = await fetcher.post<P1DoksResponse>(baseUrl, body);

      if (!resp.json) {
        errors.push(`HTTP ${resp.status} on ${baseUrl} offset=${offset}`);
        break;
      }

      const items = Array.isArray(resp.json.data_pack) ? resp.json.data_pack : [];
      const aggregated = Array.isArray(resp.json.data_pack_aggregated) ? resp.json.data_pack_aggregated : [];
      if (totalAvailable == null && aggregated.length > 0 && aggregated[0]?.count?.id != null) {
        totalAvailable = aggregated[0].count.id;
        console.log(`  total available for ${target.year} S${target.seasonNum}: ${totalAvailable}`);
      }

      console.log(`  page: ${items.length} items`);

      if (items.length === 0) break;

      for (const item of items) {
        try {
          if (typeof item.Week !== "number" || item.Week < 1 || item.Week > 13) continue;
          const weekRow = weekByNum.get(item.Week);
          if (!weekRow) continue;

          const carName = canonicalizeCarName((item.Car || "").trim());
          const trackNameRaw = (item.Track || "").trim();
          if (!carName || !trackNameRaw) continue;

          const seriesName = (item.Series || "").trim() || null;
          const categoryName = categoryForSeries(seriesName ?? "");
          const categoryRow = categoryByName.get(categoryName) ?? defaultCategory;

          const canonicalClass = await lookupCanonicalClass(
            prisma,
            carName,
            seriesName || "UNKNOWN",
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

          const canonicalTrackName = canonicalizeTrackName(trackNameRaw);
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

          // Compute the listing's lap time in seconds. Prefer the discrete
          // lap_minutes/lap_seconds/lap_hundredths fields (always present per probe);
          // fall back to parsing lap_time_formatted if needed.
          let timeSeconds: number | null = null;
          if (
            typeof item.lap_minutes === "number" &&
            typeof item.lap_seconds === "number" &&
            (typeof item.lap_hundredths === "string" || typeof item.lap_hundredths === "number")
          ) {
            const minutes = item.lap_minutes;
            const seconds = item.lap_seconds;
            const hundredthsRaw = item.lap_hundredths;
            const hundredthsStr = String(hundredthsRaw).padStart(3, "0").slice(0, 3);
            const hundredthsNum = parseInt(hundredthsStr, 10);
            if (
              Number.isFinite(minutes) &&
              Number.isFinite(seconds) &&
              Number.isFinite(hundredthsNum) &&
              minutes >= 0 &&
              seconds >= 0 &&
              hundredthsNum >= 0
            ) {
              // The "hundredths" field is actually thousandths in observed data
              // ("048", "375"); divide by 1000 not 100. lap_time_formatted
              // confirms: lap_minutes=0, lap_seconds=17, lap_hundredths="048" ->
              // formatted "0:17.048" -> 17.048s.
              timeSeconds = minutes * 60 + seconds + hundredthsNum / 1000;
            }
          }
          if (timeSeconds == null && item.lap_time_formatted) {
            // Fallback parser: "M:SS.SSS"
            const m = /^(\d+):(\d+)\.(\d+)$/.exec(item.lap_time_formatted.trim());
            if (m) {
              const minutes = parseInt(m[1], 10);
              const seconds = parseInt(m[2], 10);
              const fracStr = m[3].padEnd(3, "0").slice(0, 3);
              const frac = parseInt(fracStr, 10) / 1000;
              if (Number.isFinite(minutes) && Number.isFinite(seconds) && Number.isFinite(frac)) {
                timeSeconds = minutes * 60 + seconds + frac;
              }
            }
          }

          const listingUrl = `${SITE_HOST}/data-pack/${item.id}`;
          const priceCents = typeof item.price === "number" ? item.price : null;
          const priceUsd = priceCents != null ? priceCents / 100 : null;

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
              price: priceUsd,
              series: seriesName,
              lastSeenAt: new Date(),
            },
            update: {
              // Don't churn the deep-link URL on every refresh -- multiple datapacks
              // per (car, track, week) exist; first-seen wins for the deep link
              // unless we have nothing yet. Always bump lastSeenAt + series.
              ...(existing?.url ? {} : { url: listingUrl }),
              series: seriesName,
              price: priceUsd,
              lastSeenAt: new Date(),
            },
          });

          if (timeSeconds != null && timeSeconds > 0) {
            const previous = existing?.lapTime?.timeSeconds ?? Number.POSITIVE_INFINITY;
            if (timeSeconds < previous) {
              await prisma.lapTime.upsert({
                where: { setupListingId: upserted.id },
                create: {
                  setupListingId: upserted.id,
                  timeSeconds,
                  source: "SHOP_PUBLISHED",
                },
                update: {
                  timeSeconds,
                  source: "SHOP_PUBLISHED",
                },
              });
            }
          }

          if (existing) totalUpdated++;
          else totalInserted++;
          totalFetched++;
        } catch (err) {
          errors.push(`upsert failed for P1Doks id ${item.id}: ${(err as Error).message.slice(0, 200)}`);
        }
      }

      // Stop conditions:
      //   - fewer items returned than the page size = last page
      //   - we've covered the aggregated total
      if (items.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
      if (totalAvailable != null && offset >= totalAvailable) break;
      // Safety net: cap iterations defensively.
      if (offset > 5000) {
        errors.push(`pagination ran past offset 5000; aborting`);
        break;
      }
    }

    if (totalInserted + totalUpdated > 0) {
      await prisma.shop.update({
        where: { id: shop.id },
        data: {
          scrapingStatus: "AUTH_SCRAPED",
          notes: "Public catalog endpoint /ql/data-packs (no auth header required for catalog reads). Scraped weekly.",
        },
      });
      console.log(`shop status -> AUTH_SCRAPED`);
    }
  } catch (err) {
    const msg = (err as Error).message;
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
    `P1Doks scraper done. fetched=${totalFetched} inserted=${totalInserted} updated=${totalUpdated} errors=${errors.length}`,
  );

  return { fetched: totalFetched, inserted: totalInserted, updated: totalUpdated, errors };
}
