/**
 * HYMO scraper CLI wrapper.
 *
 * Round 5: the actual scrape logic lives in lib/scrape/hymo.ts so it can be
 * called from the production /api/ingest route (Next.js standalone tracing
 * follows app/ imports). This wrapper preserves the existing developer flow
 * `npm run scrape:hymo` for local runs against ./dev.db (or DATABASE_PATH).
 */
import "dotenv/config";
import path from "path";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { runHymoScrape } from "../lib/scrape/hymo";

function getDbPath() {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  return path.resolve(process.cwd(), "dev.db");
}

const adapter = new PrismaBetterSqlite3({ url: `file:${getDbPath()}` });
const prisma = new PrismaClient({ adapter });

runHymoScrape(prisma)
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
