/**
 * GET /api/picker/classes?year=YYYY&quarter=N
 * Returns distinct carClass values that have ≥1 listing in the chosen season.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseSeasonParams, resolveSeason } from "@/lib/season-resolve";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: NextRequest) {
  const parsed = parseSeasonParams(request.nextUrl.searchParams);
  if (parsed && "error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: CORS_HEADERS });
  }

  const season = await resolveSeason(parsed);
  if (!season) return NextResponse.json({ classes: [] }, { headers: CORS_HEADERS });

  try {
    const listings = await prisma.setupListing.findMany({
      where: { seasonWeek: { seasonId: season.id } },
      select: { car: { select: { carClass: true } } },
      distinct: ["carId"],
    });
    const set = new Set<string>();
    for (const l of listings) {
      if (l.car?.carClass) set.add(l.car.carClass);
    }
    const classes = Array.from(set).filter((c) => c.length > 0).sort();
    return NextResponse.json({ classes }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error("[picker/classes] error:", (err as Error).message);
    return NextResponse.json({ error: "Failed to load classes" }, { status: 500, headers: CORS_HEADERS });
  }
}
