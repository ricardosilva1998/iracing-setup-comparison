import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import path from "path";

function getDbPath() {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  return path.resolve(process.cwd(), "dev.db");
}

const adapter = new PrismaBetterSqlite3({ url: `file:${getDbPath()}` });
const prisma = new PrismaClient({ adapter });

const SHOPS = [
  {
    name: "HYMO Setups",
    url: "https://www.hymosetups.com",
    scrapingStatus: "SCRAPED",
    notes: "Public catalog pages render in SSR. Scraped weekly.",
  },
  {
    name: "Grid-and-Go",
    url: "https://app.grid-and-go.com",
    scrapingStatus: "LOGIN_WALLED",
    notes: "Single-page app behind login. No public catalog.",
  },
  {
    name: "Coach Dave Academy",
    url: "https://coachdaveacademy.com/product-category/iracing-setups/",
    scrapingStatus: "CLOUDFLARE_BLOCKED",
    notes: "Cloudflare protection blocks plain HTTP clients.",
  },
  {
    name: "P1Doks",
    url: "https://p1doks.com",
    scrapingStatus: "API_LOCKED",
    notes: "All API endpoints require authenticated session.",
  },
];

const CATEGORIES = [
  "Road",
  "Oval",
  "Sports Car",
  "Formula",
  "Dirt Road",
  "Dirt Oval",
];

// Current season placeholder -- refresh once iRacing rolls a new build.
const CURRENT_SEASON = { year: 2026, quarter: 2, label: "2026 S2" };

async function main() {
  console.log("Seeding iracing-setup-comparison database...\n");

  for (const s of SHOPS) {
    await prisma.shop.upsert({
      where: { name: s.name },
      create: s,
      update: { url: s.url, scrapingStatus: s.scrapingStatus, notes: s.notes },
    });
  }
  console.log(`Seeded ${SHOPS.length} shops.`);

  for (const name of CATEGORIES) {
    await prisma.category.upsert({
      where: { name },
      create: { name },
      update: {},
    });
  }
  console.log(`Seeded ${CATEGORIES.length} categories.`);

  const season = await prisma.season.upsert({
    where: { year_quarter: { year: CURRENT_SEASON.year, quarter: CURRENT_SEASON.quarter } },
    create: CURRENT_SEASON,
    update: { label: CURRENT_SEASON.label },
  });

  for (let weekNum = 1; weekNum <= 13; weekNum++) {
    await prisma.seasonWeek.upsert({
      where: { seasonId_weekNum: { seasonId: season.id, weekNum } },
      create: {
        seasonId: season.id,
        weekNum,
        label: weekNum === 13 ? "Week 13" : `Week ${weekNum}`,
      },
      update: {},
    });
  }
  console.log(`Seeded ${CURRENT_SEASON.label} with 13 weeks.`);

  const counts = {
    shops: await prisma.shop.count(),
    categories: await prisma.category.count(),
    seasons: await prisma.season.count(),
    weeks: await prisma.seasonWeek.count(),
  };
  console.log("\nVerification:");
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k}: ${v}`);
  }
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
