/**
 * P1Doks scraper CLI wrapper.
 *
 * Round 11. The actual scrape logic lives in lib/scrape/p1doks.ts so it can
 * be called from the production /api/ingest route (Next.js standalone tracing
 * follows app/ imports). This wrapper preserves the existing developer flow
 * `npm run scrape:p1doks` for local runs against ./dev.db (or DATABASE_PATH).
 */
import "dotenv/config";
import path from "path";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { runP1DoksScrape } from "../lib/scrape/p1doks";

function getDbPath() {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  return path.resolve(process.cwd(), "dev.db");
}

const adapter = new PrismaBetterSqlite3({ url: `file:${getDbPath()}` });
const prisma = new PrismaClient({ adapter });

runP1DoksScrape(prisma)
  .then((result) => {
    console.log(
      `\nresult: inserted=${result.inserted} updated=${result.updated} errors=${result.errors.length}`,
    );
  })
  .catch((e) => {
    console.error("Scraper crashed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
