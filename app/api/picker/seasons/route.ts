/**
 * GET /api/picker/seasons
 * Returns the list of seasons with aggregate setupCount per season.
 * Ordered: year DESC, quarter DESC.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET() {
  try {
    const seasons = await prisma.season.findMany({
      orderBy: [{ year: "desc" }, { quarter: "desc" }],
      select: { id: true, year: true, quarter: true, label: true },
    });

    const grouped = await prisma.setupListing.groupBy({
      by: ["seasonWeekId"],
      _count: { id: true },
    });

    const seasonWeeks = await prisma.seasonWeek.findMany({
      select: { id: true, seasonId: true },
    });
    const weekToSeason = new Map<number, number>();
    for (const w of seasonWeeks) weekToSeason.set(w.id, w.seasonId);

    const countBySeason = new Map<number, number>();
    for (const g of grouped) {
      const sid = weekToSeason.get(g.seasonWeekId);
      if (sid != null) countBySeason.set(sid, (countBySeason.get(sid) ?? 0) + g._count.id);
    }

    const result = seasons.map((s) => ({
      year: s.year,
      quarter: s.quarter,
      label: s.label,
      setupCount: countBySeason.get(s.id) ?? 0,
    }));

    return NextResponse.json({ seasons: result }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error("[picker/seasons] error:", (err as Error).message);
    return NextResponse.json({ error: "Failed to load seasons" }, { status: 500, headers: CORS_HEADERS });
  }
}
