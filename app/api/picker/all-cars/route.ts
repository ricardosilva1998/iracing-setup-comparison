/**
 * GET /api/picker/all-cars
 *
 * Public endpoint used by the bridge app to populate the bulk-download car
 * list. Returns every canonical car in the DB (no week/track filter) with
 * the pre-mapped iRacing setup folder name where known.
 *
 * Response: { cars: [{ id, name, carClass, iracingFolderName: string | null }, ...] }
 *
 * No auth required — same data that drives the public /compare page.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
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

export async function GET() {
  try {
    const rows = await prisma.car.findMany({
      select: { id: true, name: true, carClass: true },
      orderBy: { name: "asc" },
    });

    const cars = rows.map((row: { id: number; name: string; carClass: string }) => ({
      id: row.id,
      name: row.name,
      carClass: row.carClass,
      iracingFolderName: lookupIracingFolder(row.name),
    }));

    return NextResponse.json({ cars }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error("[picker/all-cars] error:", (err as Error).message);
    return NextResponse.json(
      { error: "Failed to load cars" },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
