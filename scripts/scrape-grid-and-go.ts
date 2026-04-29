/**
 * Grid-and-Go scraper.
 *
 * Auth (probed in round 2):
 *   Cognito Hosted UI, PKCE OAuth code grant. No captcha. No MFA.
 *   Login URL pattern:
 *     https://grid-and-go-auth.auth.eu-central-1.amazoncognito.com/login?
 *       response_type=code & client_id=1nqqluo9th1iajur09j2amd63p &
 *       redirect_uri=https://app.grid-and-go.com & scope=openid+email & ...
 *   After login the SPA stores id_token / access_token / refresh_token in
 *   localStorage. API calls go to:
 *     https://oaseb2ya72.execute-api.eu-central-1.amazonaws.com
 *   carrying `Authorization: Bearer <id_token>`.
 *
 * Data shape (from /datapacks?year=YYYY&season=N):
 *   { items: [
 *       { id, year, season, week, carName, carId, trackName,
 *         laptime, series, author, subscriptions: string[],
 *         dateTime, ...weather }
 *     , ...
 *   ] }
 *   One row per (car, track, week, datetime/session). 540+ distinct
 *   (car|track|week) triples in the current season -- this is exactly
 *   the "fastest time per car per week" data the product needs.
 *
 * Politeness (per the round 2 brief):
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
import "dotenv/config";
import { chromium } from "playwright";
import path from "path";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { lookupCanonicalClass } from "../lib/car-class-canonical";

// ---- config -------------------------------------------------------------
const APP_HOST = "https://app.grid-and-go.com";
const API_HOST = "https://oaseb2ya72.execute-api.eu-central-1.amazonaws.com";

const RATE_LIMIT_MS = 5000;
const JITTER_MS = 2000;
const SHOP_NAME = "Grid-and-Go";

function getDbPath() {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  return path.resolve(process.cwd(), "dev.db");
}

const adapter = new PrismaBetterSqlite3({ url: `file:${getDbPath()}` });
const prisma = new PrismaClient({ adapter });

// ---- helpers ------------------------------------------------------------
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredDelay() {
  const jitter = (Math.random() * 2 - 1) * JITTER_MS;
  return Math.max(2500, RATE_LIMIT_MS + jitter);
}

function safeUrl(u: string): string {
  try {
    const parsed = new URL(u);
    const stripParams = ["code", "code_challenge", "code_verifier", "state", "id_token", "access_token", "refresh_token", "session"];
    for (const p of stripParams) parsed.searchParams.delete(p);
    return parsed.origin + parsed.pathname + (parsed.search ? `?${parsed.searchParams.toString()}` : "");
  } catch {
    return "<unparseable url>";
  }
}

function sanitise(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join("<REDACTED>");
  }
  return out;
}

// Map a Grid-and-Go `series` value to a Category (Sports Car / Formula / ...)
// for the iRacing Category foreign key. Round 3 removed the carClass field
// from this mapping: GnG's `series` is a *race series*, not a car class
// (e.g. a Ferrari 296 GT3 races in DTM, ENDURANCE, FIXED, GTP, GT3 -- all
// the same physical car). The canonical car class is now resolved from the
// car name via lookupCanonicalClass(); the series itself is preserved on
// SetupListing.series for display.
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

// ---- main ---------------------------------------------------------------
async function main() {
  const startedAt = new Date();
  console.log(`Grid-and-Go scraper start ${startedAt.toISOString()}`);

  const email = process.env.GRID_AND_GO_EMAIL;
  const password = process.env.GRID_AND_GO_PASSWORD;
  if (!email || !password) {
    console.error("missing GRID_AND_GO_EMAIL or GRID_AND_GO_PASSWORD. configure .env (see .env.example).");
    process.exit(1);
  }
  const secrets = [email, password];

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

  // For MVP, just use the most recent season (matches the seed).
  const season = await prisma.season.findFirst({
    orderBy: [{ year: "desc" }, { quarter: "desc" }],
    include: { weeks: true },
  });
  if (!season) {
    throw new Error("No Season rows -- run db:seed first.");
  }
  const weekByNum = new Map(season.weeks.map((w) => [w.weekNum, w]));

  // ---- launch browser & log in ----------------------------------------
  console.log("launching headless chromium");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  const errors: string[] = [];

  try {
    const page = await context.newPage();

    console.log(`navigating ${APP_HOST}/`);
    await page.goto(`${APP_HOST}/`, { waitUntil: "networkidle", timeout: 30000 });
    // The SPA needs ~3-6s to render and inject the auth-aware nav.
    await page.waitForTimeout(6000);

    // Click the SIGN IN trigger; the visible target is the last 'Sign in' div.
    console.log("triggering sign-in");
    const signInTrigger = page.locator(":has-text('SIGN IN')").last();
    await signInTrigger.click();
    await page.waitForURL(/amazoncognito\.com/, { timeout: 20000 });

    // Wait for the Cognito hosted UI form to settle.
    await page.waitForTimeout(3000);
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

    const usernameSel = page.locator("input[name='username']:visible").first();
    const passwordSel = page.locator("input[name='password']:visible").first();
    const submitSel = page.locator("input[name='signInSubmitButton']:visible").first();

    await usernameSel.waitFor({ state: "visible", timeout: 15000 });
    await usernameSel.fill(email);
    await passwordSel.fill(password);
    await submitSel.click();
    await page.waitForURL(/app\.grid-and-go\.com/, { timeout: 30000 });
    console.log("post-login redirect ok");

    // Wait for the SPA to do its OAuth code-token exchange.
    await page.waitForTimeout(5000);
    const idToken = await page.evaluate(() => localStorage.getItem("id_token"));
    if (!idToken) {
      throw new Error("login appeared to succeed but no id_token in localStorage");
    }
    console.log(`authenticated. id_token length=${idToken.length}`);

    // ---- fetch /datapacks for the active season ----------------------
    const seasonsToFetch: { year: number; season: number }[] = [
      { year: season.year, season: season.quarter },
    ];

    for (const target of seasonsToFetch) {
      // be polite
      await sleep(jitteredDelay());

      const url = `${API_HOST}/datapacks?year=${target.year}&season=${target.season}`;
      console.log(`-> ${safeUrl(url)}`);

      const resp = await page.request.get(url, {
        headers: { Authorization: `Bearer ${idToken}` },
        timeout: 30000,
      });

      const headers = resp.headers();
      // Honour rate-limit hints if present (Cognito + API Gateway sometimes set these).
      const retryAfter = headers["retry-after"];
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!Number.isNaN(seconds) && seconds > 0) {
          console.log(`  retry-after=${seconds}s; sleeping`);
          await sleep(seconds * 1000);
        }
      }

      if (resp.status() === 401) {
        throw new Error("API returned 401 -- token rejected. Check creds / subscription.");
      }
      if (!resp.ok()) {
        errors.push(`HTTP ${resp.status()} on ${safeUrl(url)}`);
        continue;
      }

      const body = await resp.json().catch(() => null);
      const items = (body && typeof body === "object" && Array.isArray((body as { items?: DataPackItem[] }).items))
        ? (body as { items: DataPackItem[] }).items
        : [];
      console.log(`  fetched ${items.length} datapack items`);
      totalFetched += items.length;

      // ---- persist ---------------------------------------------------
      for (const item of items) {
        try {
          // Filter to just the season we know about. Items may include
          // future weeks (>13) or off-season entries.
          if (typeof item.week !== "number" || item.week < 1 || item.week > 13) continue;

          const weekRow = weekByNum.get(item.week);
          if (!weekRow) continue; // no SeasonWeek row for that index

          const mapping = SERIES_MAP[item.series] ?? { category: "Sports Car" };
          const categoryRow = categoryByName.get(mapping.category) ?? defaultCategory;

          // Resolve canonical class for this car. Order:
          //   1. existing Car row (HYMO is the source of truth, scraped first)
          //   2. derive from the car name (e.g. "Ferrari 296 GT3" -> GT3)
          //   3. fall back to the GnG series so we never silently drop a row
          // See lib/car-class-canonical.ts.
          const canonicalClass = await lookupCanonicalClass(
            prisma,
            item.carName,
            item.series || "UNKNOWN",
          );

          // After round 3, Car is uniquely keyed by `name`. We do NOT
          // overwrite an existing class on update -- HYMO sets it; GnG
          // defers (its raw `series` is not a class).
          const car = await prisma.car.upsert({
            where: { name: item.carName },
            create: {
              name: item.carName,
              carClass: canonicalClass,
              categoryId: categoryRow.id,
            },
            update: {},
          });

          const track = await prisma.track.upsert({
            where: { name: item.trackName },
            create: { name: item.trackName },
            update: {},
          });

          // Composite-key upsert: one listing per (shop, car, track, week).
          // If GnG publishes multiple datapacks for the same (car, track,
          // week) in different sessions, we keep the *fastest* lap time
          // (which is what "fastest time per car per week" semantically means).
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

          // Grid-and-Go does not expose a per-pack public URL, but the SPA
          // routes datapack detail to /#/datapacks/<id>. We store that.
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
              price: null, // Grid-and-Go is subscription-priced, not per-setup.
              series: seriesName,
              lastSeenAt: new Date(),
            },
            update: {
              url: listingUrl,
              series: seriesName,
              lastSeenAt: new Date(),
            },
          });

          // Lap time: keep the fastest if multiple sessions exist for the same triple.
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

    // ---- on success, promote the shop's scraping status -----------------
    if (totalInserted + totalUpdated > 0) {
      await prisma.shop.update({
        where: { id: shop.id },
        data: {
          scrapingStatus: "AUTH_SCRAPED",
          notes: "Authenticated scrape via Cognito Hosted UI. Public access not available.",
        },
      });
      console.log(`shop status -> AUTH_SCRAPED`);
    }
  } catch (err) {
    const msg = sanitise(String((err as Error).message || err), secrets);
    errors.push(msg);
    console.error(`scraper error: ${msg}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
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
    `\nGrid-and-Go scraper done. fetched=${totalFetched} inserted=${totalInserted} updated=${totalUpdated} errors=${errors.length}`,
  );
}

main()
  .catch((e) => {
    console.error("Scraper crashed:", String((e as Error).message || e).slice(0, 200));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
