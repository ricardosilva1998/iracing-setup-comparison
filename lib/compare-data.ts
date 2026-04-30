import { prisma } from "@/lib/db";
import type {
  CompareRow,
  CompareCell,
  ScrapingStatus,
  LapTimeSource,
} from "@/lib/types";

export type CompareFilters = {
  seasonId?: number;
  carClass?: string;
  weekNum?: number;
  trackId?: number;
};

export type CompareData = {
  shops: { id: number; name: string; scrapingStatus: ScrapingStatus }[];
  carClasses: string[];
  seasons: { id: number; year: number; quarter: number; label: string }[];
  weeks: { id: number; weekNum: number; label: string }[];
  tracks: { id: number; name: string }[];
  selectedSeasonId: number | null;
  selectedCarClass: string | null;
  selectedWeekNum: number | null;
  selectedTrackId: number | null;
  rows: CompareRow[];
};

/**
 * Loads everything /compare needs in one server-side call.
 * Cells are returned in stable shop-id order so the columns line up.
 */
export async function getCompareData(filters: CompareFilters): Promise<CompareData> {
  const [shops, carClassesRaw, seasons, tracks] = await Promise.all([
    prisma.shop.findMany({ orderBy: { id: "asc" } }),
    prisma.car.findMany({
      select: { carClass: true },
      distinct: ["carClass"],
      orderBy: { carClass: "asc" },
    }),
    prisma.season.findMany({
      orderBy: [{ year: "desc" }, { quarter: "desc" }],
    }),
    prisma.track.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const selectedSeasonId = filters.seasonId ?? (seasons[0]?.id ?? null);

  const weeks = selectedSeasonId
    ? await prisma.seasonWeek.findMany({
        where: { seasonId: selectedSeasonId },
        orderBy: { weekNum: "asc" },
      })
    : [];

  const selectedWeekNum = filters.weekNum ?? null;
  const selectedCarClass = filters.carClass ?? null;
  const selectedTrackId = filters.trackId ?? null;

  // Build the (car, track) row set: every (car, track) pair for which any
  // shop has a SetupListing under the chosen filters. Rows for which no shop
  // has data still surface as a "no shop has this combo" empty-state row at
  // the page level, but only if filters disambiguate -- otherwise we'd
  // produce a Cartesian explosion.
  const listingWhere: Record<string, unknown> = {};
  if (selectedSeasonId) {
    listingWhere.seasonWeek = {
      seasonId: selectedSeasonId,
      ...(selectedWeekNum ? { weekNum: selectedWeekNum } : {}),
    };
  }
  if (selectedCarClass) {
    listingWhere.car = { carClass: selectedCarClass };
  }
  if (selectedTrackId) {
    listingWhere.trackId = selectedTrackId;
  }

  const listings = await prisma.setupListing.findMany({
    where: listingWhere,
    include: { car: true, track: true, shop: true, lapTime: true },
    orderBy: [{ car: { name: "asc" } }, { track: { name: "asc" } }],
  });

  const rowMap = new Map<string, CompareRow>();
  for (const l of listings) {
    const key = `${l.carId}:${l.trackId}`;
    if (!rowMap.has(key)) {
      rowMap.set(key, {
        carId: l.carId,
        carName: l.car.name,
        carClass: l.car.carClass,
        trackId: l.trackId,
        trackName: l.track.name,
        cells: shops.map((s) => ({
          shopId: s.id,
          shopName: s.name,
          scrapingStatus: s.scrapingStatus as ScrapingStatus,
          url: undefined,
          price: null,
          lapTimeSeconds: null,
          lapTimeSource: null,
        })),
      });
    }
    const row = rowMap.get(key)!;
    const idx = row.cells.findIndex((c) => c.shopId === l.shopId);
    if (idx >= 0) {
      const filled: CompareCell = {
        ...row.cells[idx],
        url: l.url,
        price: l.price,
        lapTimeSeconds: l.lapTime?.timeSeconds ?? null,
        lapTimeSource: (l.lapTime?.source as LapTimeSource | undefined) ?? null,
      };
      row.cells[idx] = filled;
    }
  }

  return {
    shops: shops.map((s) => ({
      id: s.id,
      name: s.name,
      scrapingStatus: s.scrapingStatus as ScrapingStatus,
    })),
    carClasses: carClassesRaw.map((c) => c.carClass),
    seasons: seasons.map((s) => ({
      id: s.id,
      year: s.year,
      quarter: s.quarter,
      label: s.label,
    })),
    weeks: weeks.map((w) => ({
      id: w.id,
      weekNum: w.weekNum,
      label: w.label,
    })),
    tracks,
    selectedSeasonId,
    selectedCarClass,
    selectedWeekNum,
    selectedTrackId,
    rows: Array.from(rowMap.values()),
  };
}
