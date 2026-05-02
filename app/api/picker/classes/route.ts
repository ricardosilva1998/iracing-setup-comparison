/**
 * GET /api/picker/classes
 *
 * Public endpoint used by the bridge app to populate the class multi-select
 * in the Bulk Download tab. Returns every distinct Car.carClass value from the
 * DB, alphabetically sorted, with empty/null values stripped.
 *
 * Response: { classes: string[] }
 *
 * No auth required — same data displayed on the public /compare page.
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
    const rows = await prisma.car.findMany({
      select: { carClass: true },
      distinct: ["carClass"],
      orderBy: { carClass: "asc" },
    });

    const classes = rows
      .map((r: { carClass: string }) => r.carClass)
      .filter((c: string) => c != null && c.length > 0);

    return NextResponse.json({ classes }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error("[picker/classes] error:", (err as Error).message);
    return NextResponse.json(
      { error: "Failed to load classes" },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
