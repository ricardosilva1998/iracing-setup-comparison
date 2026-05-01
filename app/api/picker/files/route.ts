/**
 * GET /api/picker/files?weekNum=N&trackId=T&carId=C
 *
 * Public endpoint used by the bridge app to know which files are available
 * for a given (week, track, car) combination, per shop.
 *
 * Response:
 *   { files: [{ shopName, shopSlug, datapackId: string|null, fileNames: string[], cached: bool }] }
 *
 * Only Grid-and-Go currently has a file-download pipeline (via the
 * /api/files/[datapackId]/zip route). For all other shops, datapackId is null
 * and fileNames is [] — the bridge UI should show an "Open setup" deep-link
 * instead of an auto-download button for those shops.
 *
 * GnG datapackId is extracted from the listing URL which has the form
 * https://app.grid-and-go.com/#/datapacks/<id>. On a cache miss,
 * getOrFetchManifest triggers a GnG download — so this endpoint may be slow
 * the first time a datapack is requested. Subsequent calls are fast (cache hit).
 *
 * No auth required — same car+track+week data is on the public compare page.
 * The file CONTENT (the actual .sto files) remains gated by Basic Auth via
 * /api/files/[datapackId]/zip — this route only returns metadata (names).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { shopNameToSlug } from "@/lib/shop-slug";
import { getOrFetchManifest, validateDatapackId } from "@/lib/files-manifest";
import { lookupIracingFolder } from "@/lib/iracing-car-folders";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const GNG_URL_PREFIX = "https://app.grid-and-go.com/#/datapacks/";

/** Extract the GnG datapackId from a listing URL, or null if not a GnG URL. */
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
  const carIdRaw = searchParams.get("carId");

  const weekNum = weekNumRaw ? parseInt(weekNumRaw, 10) : NaN;
  const trackId = trackIdRaw ? parseInt(trackIdRaw, 10) : NaN;
  const carId = carIdRaw ? parseInt(carIdRaw, 10) : NaN;

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
  if (isNaN(carId) || carId < 1) {
    return NextResponse.json(
      { error: "carId must be a positive integer" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  try {
    // Resolve the active season's week row for this weekNum.
    const seasons = await prisma.season.findMany({
      orderBy: [{ year: "desc" }, { quarter: "desc" }],
      take: 1,
    });
    const activeSeasonId = seasons[0]?.id ?? null;

    if (!activeSeasonId) {
      return NextResponse.json({ files: [], iracingFolderName: null }, { headers: CORS_HEADERS });
    }

    const seasonWeek = await prisma.seasonWeek.findUnique({
      where: { seasonId_weekNum: { seasonId: activeSeasonId, weekNum } },
    });

    if (!seasonWeek) {
      return NextResponse.json({ files: [], iracingFolderName: null }, { headers: CORS_HEADERS });
    }

    const listings = await prisma.setupListing.findMany({
      where: { seasonWeekId: seasonWeek.id, trackId, carId },
      select: {
        url: true,
        externalId: true,
        shop: { select: { name: true } },
        car: { select: { name: true } },
      },
      orderBy: { shopId: "asc" },
    });

    // Resolve the car's iRacing folder from the first listing (all share the same car).
    const carName = listings[0]?.car.name ?? null;
    const iracingFolderName = carName ? lookupIracingFolder(carName) : null;

    const result = await Promise.all(
      listings.map(async (listing) => {
        const shopName = listing.shop.name;
        const shopSlug = shopNameToSlug(shopName);
        const datapackId = extractGngDatapackId(listing.url);

        if (!datapackId) {
          // Non-GnG shop or GnG listing with unexpected URL shape.
          return {
            shopName,
            shopSlug,
            datapackId: null as string | null,
            externalId: listing.externalId ?? null,
            fileNames: [] as string[],
            cached: false,
          };
        }

        // GnG path — fetch (or return cached) manifest.
        // externalId is null for GnG: its file ID is datapackId (kept for backward compat).
        try {
          const manifest = await getOrFetchManifest(datapackId);
          return {
            shopName,
            shopSlug,
            datapackId,
            externalId: null as string | null,
            fileNames: manifest.files.map((f) => f.name),
            cached: manifest.cached,
          };
        } catch (err) {
          // Don't fail the whole response if one manifest fetch fails.
          const e = err as Error & { httpStatus?: number };
          console.error(`[picker/files] manifest error for ${datapackId}: ${e.message}`);
          return {
            shopName,
            shopSlug,
            datapackId,
            externalId: null as string | null,
            fileNames: [],
            cached: false,
          };
        }
      }),
    );

    return NextResponse.json({ files: result, iracingFolderName }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error("[picker/files] error:", (err as Error).message);
    return NextResponse.json(
      { error: "Failed to load files" },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
