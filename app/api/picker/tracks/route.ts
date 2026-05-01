/**
 * GET /api/picker/tracks?weekNum=N
 *
 * Public endpoint used by the bridge app to populate the Track dropdown
 * after the user has selected a week.
 *
 * Response: { tracks: [{ id, name, setupCount }, ...] }
 *
 * Only tracks with setupCount > 0 are returned (the bridge has no use for
 * zero-count entries — those are tracks with no setups this week).
 *
 * No auth required — same data displayed on the public /week/[weekNum] page.
 */
import { NextRequest, NextResponse } from "next/server";
import { getTrackList } from "@/lib/compare-data";

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
    return NextResponse.json(
      { error: "weekNum must be an integer between 1 and 13" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  try {
    const data = await getTrackList(weekNum, {});
    // Only return tracks that have at least one setup this week.
    const tracks = data.tracks
      .filter((t) => t.setupCount > 0)
      .map((t) => ({
        id: t.id,
        name: t.name,
        setupCount: t.setupCount,
      }));
    return NextResponse.json({ tracks }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error("[picker/tracks] error:", (err as Error).message);
    return NextResponse.json(
      { error: "Failed to load tracks" },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
