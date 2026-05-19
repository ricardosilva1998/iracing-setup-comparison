/**
 * GET /api/picker/cars?weekNum=N&trackId=T&year=YYYY&quarter=N
 */
import { NextRequest, NextResponse } from "next/server";
import { getTrackCompareData } from "@/lib/compare-data";
import { lookupIracingFolder } from "@/lib/iracing-car-folders";
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
  const { searchParams } = request.nextUrl;
  const weekNumRaw = searchParams.get("weekNum");
  const trackIdRaw = searchParams.get("trackId");

  const weekNum = weekNumRaw ? parseInt(weekNumRaw, 10) : NaN;
  const trackId = trackIdRaw ? parseInt(trackIdRaw, 10) : NaN;

  if (isNaN(weekNum) || weekNum < 1 || weekNum > 13) {
    return NextResponse.json({ error: "weekNum must be an integer between 1 and 13" }, { status: 400, headers: CORS_HEADERS });
  }
  if (isNaN(trackId) || trackId < 1) {
    return NextResponse.json({ error: "trackId must be a positive integer" }, { status: 400, headers: CORS_HEADERS });
  }

  const parsed = parseSeasonParams(searchParams);
  if (parsed && "error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: CORS_HEADERS });
  }

  const season = await resolveSeason(parsed);
  if (!season) return NextResponse.json({ cars: [] }, { headers: CORS_HEADERS });

  try {
    const data = await getTrackCompareData(weekNum, trackId, { seasonId: season.id });
    const seen = new Set<number>();
    const cars = data.rows
      .filter((row) => {
        if (seen.has(row.carId)) return false;
        seen.add(row.carId);
        return true;
      })
      .map((row) => ({
        id: row.carId,
        name: row.carName,
        carClass: row.carClass,
        iracingFolderName: lookupIracingFolder(row.carName),
      }));
    return NextResponse.json({ cars }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error("[picker/cars] error:", (err as Error).message);
    return NextResponse.json({ error: "Failed to load cars" }, { status: 500, headers: CORS_HEADERS });
  }
}
