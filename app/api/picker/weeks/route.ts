/**
 * GET /api/picker/weeks
 *
 * Public endpoint used by the bridge app to populate the Week dropdown.
 * Wraps getWeekList({}) — no filters applied by default (current season).
 *
 * Response: { weeks: [{ weekNum, label, setupCount }, ...] }
 *
 * No auth required — same data displayed on the public home page.
 */
import { NextResponse } from "next/server";
import { getWeekList } from "@/lib/compare-data";

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
    const data = await getWeekList({});
    const weeks = data.weeks.map((w) => ({
      weekNum: w.weekNum,
      label: w.label,
      setupCount: w.setupCount,
    }));
    return NextResponse.json({ weeks }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error("[picker/weeks] error:", (err as Error).message);
    return NextResponse.json(
      { error: "Failed to load weeks" },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
