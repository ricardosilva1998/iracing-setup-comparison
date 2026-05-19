/**
 * Helpers for resolving the optional ?year&quarter query params on picker
 * routes to a concrete Season row from the DB.
 */
import { prisma } from "@/lib/db";

export type SeasonSelector = { year: number; quarter: number };

export type ResolvedSeason = {
  id: number;
  year: number;
  quarter: number;
  label: string;
};

/**
 * Parse `?year` + `?quarter` from URLSearchParams. Returns:
 *   - null if both missing (caller should use active-season fallback)
 *   - { error } if exactly one is provided, or values fail validation
 *   - SeasonSelector if both are valid
 */
export function parseSeasonParams(
  searchParams: URLSearchParams,
): SeasonSelector | null | { error: string } {
  const yearRaw = searchParams.get("year");
  const quarterRaw = searchParams.get("quarter");

  if (yearRaw == null && quarterRaw == null) return null;
  if (yearRaw == null || quarterRaw == null) {
    return { error: "year and quarter must both be set, or both omitted" };
  }

  const year = parseInt(yearRaw, 10);
  const quarter = parseInt(quarterRaw, 10);

  if (Number.isNaN(year) || year < 2020 || year > 2030) {
    return { error: "year must be an integer between 2020 and 2030" };
  }
  if (Number.isNaN(quarter) || quarter < 1 || quarter > 4) {
    return { error: "quarter must be an integer between 1 and 4" };
  }

  return { year, quarter };
}

/**
 * Resolve a SeasonSelector (or null = active fallback) to a Season row.
 * Returns null if no matching row exists.
 */
export async function resolveSeason(
  selector: SeasonSelector | null,
): Promise<ResolvedSeason | null> {
  if (selector) {
    const row = await prisma.season.findUnique({
      where: { year_quarter: { year: selector.year, quarter: selector.quarter } },
      select: { id: true, year: true, quarter: true, label: true },
    });
    return row;
  }
  const active = await prisma.season.findFirst({
    where: { isActive: true },
    select: { id: true, year: true, quarter: true, label: true },
  });
  if (active) return active;
  const latest = await prisma.season.findFirst({
    orderBy: [{ year: "desc" }, { quarter: "desc" }],
    select: { id: true, year: true, quarter: true, label: true },
  });
  return latest;
}
