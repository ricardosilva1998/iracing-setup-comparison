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

// --- New hierarchy types ---

/** One card on the home/week-list page. */
export type WeekSummary = {
  id: number;
  weekNum: number;
  label: string;
  setupCount: number;
};

/** Payload returned by getWeekList — everything the home page needs. */
export type WeekListData = {
  shops: { id: number; name: string; scrapingStatus: ScrapingStatus }[];
  carClasses: string[];
  seasons: { id: number; year: number; quarter: number; label: string }[];
  selectedSeasonId: number | null;
  selectedCarClass: string | null;
  weeks: WeekSummary[];
};

/** One card on the /week/[weekNum] track-list page. */
export type TrackSummary = {
  id: number;
  name: string;
  setupCount: number;
};

/** Payload returned by getTrackList — everything the week page needs. */
export type TrackListData = {
  shops: { id: number; name: string; scrapingStatus: ScrapingStatus }[];
  carClasses: string[];
  seasons: { id: number; year: number; quarter: number; label: string }[];
  selectedSeasonId: number | null;
  selectedCarClass: string | null;
  weekNum: number;
  weekLabel: string;
  tracks: TrackSummary[];
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

/**
 * Returns 13 WeekSummary cards for the home page.
 * setupCount is the number of SetupListings matching the season (and class
 * filter when set). Single groupBy query — no N+1.
 */
export async function getWeekList(filters: {
  seasonId?: number;
  carClass?: string;
}): Promise<WeekListData> {
  const [shops, carClassesRaw, seasons] = await Promise.all([
    prisma.shop.findMany({ orderBy: { id: "asc" } }),
    prisma.car.findMany({
      select: { carClass: true },
      distinct: ["carClass"],
      orderBy: { carClass: "asc" },
    }),
    prisma.season.findMany({
      orderBy: [{ year: "desc" }, { quarter: "desc" }],
    }),
  ]);

  const selectedSeasonId = filters.seasonId ?? (seasons[0]?.id ?? null);
  const selectedCarClass = filters.carClass ?? null;

  const allWeeks = selectedSeasonId
    ? await prisma.seasonWeek.findMany({
        where: { seasonId: selectedSeasonId },
        orderBy: { weekNum: "asc" },
      })
    : [];

  // One groupBy to count listings per week under the active filters.
  const listingWhere: Record<string, unknown> = {};
  if (selectedSeasonId) {
    listingWhere.seasonWeek = { seasonId: selectedSeasonId };
  }
  if (selectedCarClass) {
    listingWhere.car = { carClass: selectedCarClass };
  }

  const grouped = await prisma.setupListing.groupBy({
    by: ["seasonWeekId"],
    where: listingWhere,
    _count: { id: true },
  });

  const countByWeekId = new Map(grouped.map((g) => [g.seasonWeekId, g._count.id]));

  const weeks: WeekSummary[] = allWeeks.map((w) => ({
    id: w.id,
    weekNum: w.weekNum,
    label: w.label,
    setupCount: countByWeekId.get(w.id) ?? 0,
  }));

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
    selectedSeasonId,
    selectedCarClass,
    weeks,
  };
}

/**
 * Returns all tracks with a setupCount for the given week.
 * Tracks with no setups in the week (under the class filter) get setupCount=0
 * so the frontend can dim them without hiding them.
 * Invalid weekNum (e.g. 99) returns all tracks with setupCount=0 — no 500.
 */
export async function getTrackList(
  weekNum: number,
  filters: { seasonId?: number; carClass?: string }
): Promise<TrackListData> {
  const [shops, carClassesRaw, seasons, allTracks] = await Promise.all([
    prisma.shop.findMany({ orderBy: { id: "asc" } }),
    prisma.car.findMany({
      select: { carClass: true },
      distinct: ["carClass"],
      orderBy: { carClass: "asc" },
    }),
    prisma.season.findMany({
      orderBy: [{ year: "desc" }, { quarter: "desc" }],
    }),
    prisma.track.findMany({ orderBy: { name: "asc" } }),
  ]);

  const selectedSeasonId = filters.seasonId ?? (seasons[0]?.id ?? null);
  const selectedCarClass = filters.carClass ?? null;

  // Resolve the SeasonWeek row for the requested weekNum (may be null for
  // invalid weekNum values — safe fallback: all tracks get setupCount=0).
  const seasonWeek =
    selectedSeasonId && weekNum >= 1 && weekNum <= 13
      ? await prisma.seasonWeek.findUnique({
          where: { seasonId_weekNum: { seasonId: selectedSeasonId, weekNum } },
        })
      : null;

  const weekLabel = seasonWeek?.label ?? `Week ${weekNum}`;

  let countByTrackId = new Map<number, number>();
  if (seasonWeek) {
    const listingWhere: Record<string, unknown> = {
      seasonWeekId: seasonWeek.id,
    };
    if (selectedCarClass) {
      listingWhere.car = { carClass: selectedCarClass };
    }

    const grouped = await prisma.setupListing.groupBy({
      by: ["trackId"],
      where: listingWhere,
      _count: { id: true },
    });

    countByTrackId = new Map(grouped.map((g) => [g.trackId, g._count.id]));
  }

  const tracks: TrackSummary[] = allTracks.map((t) => ({
    id: t.id,
    name: t.name,
    setupCount: countByTrackId.get(t.id) ?? 0,
  }));

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
    selectedSeasonId,
    selectedCarClass,
    weekNum,
    weekLabel,
    tracks,
  };
}

/**
 * Returns the cars × shops comparison table for a single (weekNum, trackId).
 * This is the focused variant used by /week/[weekNum]/track/[trackId].
 * The legacy getCompareData is preserved unchanged for backward compat with
 * app/page.tsx until frontend-dev replaces it.
 */
export async function getTrackCompareData(
  weekNum: number,
  trackId: number,
  filters: { seasonId?: number; carClass?: string }
): Promise<CompareData> {
  return getCompareData({
    seasonId: filters.seasonId,
    carClass: filters.carClass,
    weekNum,
    trackId,
  });
}
