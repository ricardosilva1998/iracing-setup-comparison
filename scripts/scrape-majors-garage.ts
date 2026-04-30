/**
 * Majors Garage scraper CLI wrapper.
 *
 * Round 10. The actual scrape logic lives in lib/scrape/majors-garage.ts so
 * it can be called from the production /api/ingest route. This wrapper
 * preserves the developer flow `npm run scrape:majors-garage` for local runs
 * against ./dev.db (or DATABASE_PATH).
 */
import "dotenv/config";
import path from "path";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { runMajorsGarageScrape } from "../lib/scrape/majors-garage";

function getDbPath() {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  return path.resolve(process.cwd(), "dev.db");
}

const adapter = new PrismaBetterSqlite3({ url: `file:${getDbPath()}` });
const prisma = new PrismaClient({ adapter });

runMajorsGarageScrape(prisma)
  .then((result) => {
    console.log(
      `\nresult: inserted=${result.inserted} updated=${result.updated} errors=${result.errors.length}`,
    );
  })
  .catch((e) => {
    console.error("Scraper crashed:", String((e as Error).message || e).slice(0, 200));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
