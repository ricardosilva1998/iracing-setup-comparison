/**
 * Backfill orchestrator — runs all 5 scrapers against every Season row in the
 * DB, then collapses any orphan Track / Car rows via the canonical migration
 * passes. Intended to be run once after round-36 schema + seed changes to
 * populate historical season data.
 *
 * Usage:
 *   npm run backfill:seasons
 *
 * DO NOT run this in production via /api/ingest — it will exceed the 600s
 * maxDuration. Run it as a one-off local script (or via `railway run`) against
 * the target database.
 */
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

function getDbPath(): string {
  return process.env.DATABASE_PATH || path.resolve(process.cwd(), "dev.db");
}

const adapter = new PrismaBetterSqlite3({ url: `file:${getDbPath()}` });
const prisma = new PrismaClient({ adapter });

async function main() {
  // Load all known seasons from the DB (seeded by db:seed).
  const seasons = await prisma.season.findMany({
    orderBy: [{ year: "asc" }, { quarter: "asc" }],
  });
  if (seasons.length === 0) {
    throw new Error("No Season rows in DB — run `npm run db:seed` first.");
  }

  console.log(`\nBackfill starting: ${seasons.length} seasons × 5 scrapers\n`);

  const results: Record<string, unknown>[] = [];

  for (const s of seasons) {
    const seasonArg = { year: s.year, quarter: s.quarter };
    const label = `${s.year} Q${s.quarter}`;
    console.log(`\n=== Season ${label} ===`);

    // HYMO — API has no season filter; logs the season arg for traceability.
    try {
      const r = await runHymoScrape(prisma, seasonArg);
      console.log(`  HYMO: fetched=${r.fetched} inserted=${r.inserted} updated=${r.updated} errors=${r.errors}`);
      results.push({ season: label, shop: "hymo", ...r });
    } catch (e) {
      console.error(`  HYMO failed: ${(e as Error).message}`);
      results.push({ season: label, shop: "hymo", error: (e as Error).message });
    }

    // Grid-and-Go — Cognito auth + season-scoped API.
    try {
      const r = await runGridAndGoScrape(prisma, seasonArg);
      console.log(`  GnG: fetched=${r.fetched} inserted=${r.inserted} updated=${r.updated} errors=${r.errors}`);
      results.push({ season: label, shop: "grid-and-go", ...r });
    } catch (e) {
      console.error(`  GnG failed: ${(e as Error).message}`);
      results.push({ season: label, shop: "grid-and-go", error: (e as Error).message });
    }

    // GO Setups — Google Sheet + WooCommerce.
    try {
      const r = await runGosetupsScrape(prisma, seasonArg);
      console.log(`  GO Setups: fetched=${r.fetched} inserted=${r.inserted} updated=${r.updated} errors=${r.errors.length}`);
      results.push({ season: label, shop: "gosetups", ...r });
    } catch (e) {
      console.error(`  GO Setups failed: ${(e as Error).message}`);
      results.push({ season: label, shop: "gosetups", error: (e as Error).message });
    }

    // Majors Garage — Bubble.io API.
    try {
      const r = await runMajorsGarageScrape(prisma, seasonArg);
      console.log(`  MG: fetched=${r.fetched} inserted=${r.inserted} updated=${r.updated} errors=${r.errors.length}`);
      results.push({ season: label, shop: "majors-garage", ...r });
    } catch (e) {
      console.error(`  MG failed: ${(e as Error).message}`);
      results.push({ season: label, shop: "majors-garage", error: (e as Error).message });
    }

    // P1Doks — public POST endpoint.
    try {
      const r = await runP1DoksScrape(prisma, seasonArg);
      console.log(`  P1Doks: fetched=${r.fetched} inserted=${r.inserted} updated=${r.updated} errors=${r.errors.length}`);
      results.push({ season: label, shop: "p1doks", ...r });
    } catch (e) {
      console.error(`  P1Doks failed: ${(e as Error).message}`);
      results.push({ season: label, shop: "p1doks", error: (e as Error).message });
    }
  }

  // After all scrapers, collapse any orphan Track + Car rows created by
  // different shops using different name variants for the same entity.
  console.log("\n=== Post-scrape canonicalisation ===");
  try {
    const trackResult = await migrateTracks(prisma);
    console.log("  migrateTracks:", JSON.stringify(trackResult));
  } catch (e) {
    console.error("  migrateTracks failed:", (e as Error).message);
  }
  try {
    const carResult = await migrateCars(prisma);
    console.log("  migrateCars:", JSON.stringify(carResult));
  } catch (e) {
    console.error("  migrateCars failed:", (e as Error).message);
  }

  console.log("\n=== Backfill complete ===");
  console.log(JSON.stringify(results, null, 2));
}

main()
  .catch((e) => {
    console.error("Backfill failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
