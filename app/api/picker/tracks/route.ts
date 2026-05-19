/**
 * GET /api/picker/tracks?weekNum=N&year=YYYY&quarter=N
 * Only tracks with setupCount > 0 are returned.
 */
import { NextRequest, NextResponse } from "next/server";
import { getTrackList } from "@/lib/compare-data";
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
  const weekNum = weekNumRaw ? parseInt(weekNumRaw, 10) : NaN;

  if (isNaN(weekNum) || weekNum < 1 || weekNum > 13) {
    return NextResponse.json({ error: "weekNum must be an integer between 1 and 13" }, { status: 400, headers: CORS_HEADERS });
  }

  const parsed = parseSeasonParams(searchParams);
  if (parsed && "error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: CORS_HEADERS });
  }

  const season = await resolveSeason(parsed);
  if (!season) return NextResponse.json({ tracks: [] }, { headers: CORS_HEADERS });

  try {
    const data = await getTrackList(weekNum, { seasonId: season.id });
    const tracks = data.tracks
      .filter((t) => t.setupCount > 0)
      .map((t) => ({ id: t.id, name: t.name, setupCount: t.setupCount }));
    return NextResponse.json({ tracks }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error("[picker/tracks] error:", (err as Error).message);
    return NextResponse.json({ error: "Failed to load tracks" }, { status: 500, headers: CORS_HEADERS });
  }
}
