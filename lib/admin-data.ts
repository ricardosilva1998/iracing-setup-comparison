/**
 * Server-side data getters for the /admin dashboard.
 *
 * Called from app/admin/page.tsx (frontend-dev's lane). Both functions are
 * pure async — no side effects beyond Prisma reads. They are NOT exported from
 * any public API route; they run only in the server component context where the
 * Basic-Auth middleware has already authenticated the request.
 */
import { prisma } from "@/lib/db";

export interface ShopStatusRow {
  id: number;
  name: string;
  scrapingStatus: string;
  notes: string | null;
  listingCount: number;
  lapTimeCount: number;
}

export interface ScrapeRunRow {
  id: number;
  shopName: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  fetched: number;
  inserted: number;
  updated: number;
  error: string | null;
}

/**
 * Returns one row per shop with scraping status and aggregate listing/lap-time
 * counts. Uses Prisma _count on the relation so listing counts require only
 * one query. Lap-time counts are derived via a groupBy + in-memory join —
 * 5 shops and O(listings) rows, fully acceptable for SQLite at this scale.
 */
export async function getScrapingStatusList(): Promise<ShopStatusRow[]> {
  const [shops, listings, lapTimeRows] = await Promise.all([
    prisma.shop.findMany({
      select: {
        id: true,
        name: true,
        scrapingStatus: true,
        notes: true,
        _count: { select: { setupListings: true } },
      },
      orderBy: { id: "asc" },
    }),
    prisma.setupListing.findMany({
      select: { id: true, shopId: true },
    }),
    prisma.lapTime.findMany({
      select: { setupListingId: true },
    }),
  ]);

  // Build listing-id → shop-id lookup.
  const listingToShop = new Map<number, number>(
    listings.map((l) => [l.id, l.shopId]),
  );

  // Accumulate lap-time counts per shop.
  const lapCountByShop = new Map<number, number>();
  for (const lt of lapTimeRows) {
    const shopId = listingToShop.get(lt.setupListingId);
    if (shopId !== undefined) {
      lapCountByShop.set(shopId, (lapCountByShop.get(shopId) ?? 0) + 1);
    }
  }

  return shops.map((s) => ({
    id: s.id,
    name: s.name,
    scrapingStatus: s.scrapingStatus,
    notes: s.notes,
    listingCount: s._count.setupListings,
    lapTimeCount: lapCountByShop.get(s.id) ?? 0,
  }));
}

/**
 * Returns the `limit` most recent ScrapeRun rows ordered by startedAt DESC.
 * Field names match the ScrapeRun Prisma model exactly (prisma/schema.prisma).
 */
export async function getRecentScrapeRuns(limit = 20): Promise<ScrapeRunRow[]> {
  return prisma.scrapeRun.findMany({
    select: {
      id: true,
      shopName: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      fetched: true,
      inserted: true,
      updated: true,
      error: true,
    },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
}
