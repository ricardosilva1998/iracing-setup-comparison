/**
 * GET /api/picker/cars?weekNum=N&trackId=T
 *
 * Public endpoint used by the bridge app to populate the Car dropdown after
 * the user has selected a week and a track.
 *
 * Response: { cars: [{ id, name, carClass }, ...] }
 *
 * Uses getTrackCompareData which returns the full rows x shops table for the
 * (weekNum, trackId) pair. We project to car identifiers only — one entry per
 * unique car that has at least one listing at this track this week.
 *
 * No auth required — same data displayed on the public track page.
 */
import { NextRequest, NextResponse } from "next/server";
import { getTrackCompareData } from "@/lib/compare-data";
import { lookupIracingFolder } from "@/lib/iracing-car-folders";

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
    return NextResponse.json(
      { error: "weekNum must be an integer between 1 and 13" },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  if (isNaN(trackId) || trackId < 1) {
    return NextResponse.json(
      { error: "trackId must be a positive integer" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  try {
    const data = await getTrackCompareData(weekNum, trackId, {});
    // Deduplicate by carId — guard against any future data shape where the same
    // car appears more than once in the row set for this (weekNum, trackId).
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
    return NextResponse.json(
      { error: "Failed to load cars" },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
