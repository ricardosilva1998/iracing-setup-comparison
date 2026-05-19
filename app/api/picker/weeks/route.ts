/**
 * GET /api/picker/weeks?year=YYYY&quarter=N
 * Public; CORS *. Missing params → active season fallback.
 */
import { NextRequest, NextResponse } from "next/server";
import { getWeekList } from "@/lib/compare-data";
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
  if (!season) return NextResponse.json({ weeks: [] }, { headers: CORS_HEADERS });

  try {
    const data = await getWeekList({ seasonId: season.id });
    const weeks = data.weeks.map((w) => ({
      weekNum: w.weekNum,
      label: w.label,
      setupCount: w.setupCount,
    }));
    return NextResponse.json({ weeks }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error("[picker/weeks] error:", (err as Error).message);
    return NextResponse.json({ error: "Failed to load weeks" }, { status: 500, headers: CORS_HEADERS });
  }
}
