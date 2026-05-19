/**
 * GET /api/picker/tracks-by-class?weekNum=W&trackId=T&year=YYYY&quarter=N
 *
 * Returns the class-grouped track-detail payload used by the bridge app's
 * track-detail view. IDs only — no manifest pre-fetching.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { shopNameToSlug } from "@/lib/shop-slug";
import { validateDatapackId } from "@/lib/files-manifest";
import { lookupIracingFolder } from "@/lib/iracing-car-folders";
import { parseSeasonParams, resolveSeason } from "@/lib/season-resolve";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const GNG_URL_PREFIX = "https://app.grid-and-go.com/#/datapacks/";

function extractGngDatapackId(url: string): string | null {
  if (!url.startsWith(GNG_URL_PREFIX)) return null;
  const id = url.slice(GNG_URL_PREFIX.length).split("?")[0].trim();
  return validateDatapackId(id) ? id : null;
}

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

  try {
    const season = await resolveSeason(parsed);
    if (!season) {
      return NextResponse.json({ trackName: "", classes: [] }, { headers: CORS_HEADERS });
    }

    const seasonWeek = await prisma.seasonWeek.findUnique({
      where: { seasonId_weekNum: { seasonId: season.id, weekNum } },
    });

    const track = await prisma.track.findUnique({
      where: { id: trackId },
      select: { name: true },
    });

    if (!seasonWeek || !track) {
      return NextResponse.json({ trackName: track?.name ?? "", classes: [] }, { headers: CORS_HEADERS });
    }

    const listings = await prisma.setupListing.findMany({
      where: { seasonWeekId: seasonWeek.id, trackId },
      select: {
        url: true,
        externalId: true,
        car: { select: { id: true, name: true, carClass: true } },
        shop: { select: { name: true } },
      },
      orderBy: [
        { car: { carClass: "asc" } },
        { car: { name: "asc" } },
        { shopId: "asc" },
      ],
    });

    type CarEntry = {
      id: number;
      name: string;
      iracingFolderName: string | null;
      shops: Array<{
        shopSlug: string;
        shopName: string;
        datapackId: string | null;
        externalId: string | null;
        listingUrl: string;
      }>;
    };
    const byClass = new Map<string, Map<number, CarEntry>>();
    for (const l of listings) {
      const carClass = l.car.carClass || "";
      if (!byClass.has(carClass)) byClass.set(carClass, new Map());
      const carMap = byClass.get(carClass)!;
      if (!carMap.has(l.car.id)) {
        carMap.set(l.car.id, {
          id: l.car.id,
          name: l.car.name,
          iracingFolderName: lookupIracingFolder(l.car.name),
          shops: [],
        });
      }
      const car = carMap.get(l.car.id)!;
      const shopName = l.shop.name;
      const shopSlug = shopNameToSlug(shopName);
      car.shops.push({
        shopSlug,
        shopName,
        datapackId: extractGngDatapackId(l.url),
        externalId: l.externalId ?? null,
        listingUrl: l.url,
      });
    }

    const classes = Array.from(byClass.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([carClass, carMap]) => ({
        carClass,
        cars: Array.from(carMap.values()).sort((a, b) => a.name.localeCompare(b.name)),
      }));

    return NextResponse.json({ trackName: track.name, classes }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error("[picker/tracks-by-class] error:", (err as Error).message);
    return NextResponse.json({ error: "Failed to load track detail" }, { status: 500, headers: CORS_HEADERS });
  }
}
