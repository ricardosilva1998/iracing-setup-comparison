import "dotenv/config";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import path from "path";
import { runP1DoksScrape, type SeasonArg } from "../lib/scrape/p1doks";

function parseSeasonFromArgv(): SeasonArg | undefined {
  const yearArg = process.argv.find((a) => a.startsWith("--year="));
  const quarterArg = process.argv.find((a) => a.startsWith("--quarter="));
  if (!yearArg && !quarterArg) return undefined;
  if (!yearArg || !quarterArg) throw new Error("--year and --quarter must be provided together");
  const year = parseInt(yearArg.split("=")[1], 10);
  const quarter = parseInt(quarterArg.split("=")[1], 10);
  if (Number.isNaN(year) || year < 2020 || year > 2030) throw new Error("--year must be 2020-2030");
  if (Number.isNaN(quarter) || quarter < 1 || quarter > 4) throw new Error("--quarter must be 1-4");
  return { year, quarter };
}

function getDbPath(): string {
  return process.env.DATABASE_PATH || path.resolve(process.cwd(), "dev.db");
}

const adapter = new PrismaBetterSqlite3({ url: `file:${getDbPath()}` });
const prisma = new PrismaClient({ adapter });

async function main() {
  const season = parseSeasonFromArgv();
  const result = await runP1DoksScrape(prisma, season);
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((e) => {
    console.error("Scraper failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
