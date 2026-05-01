import { getTrackCompareData } from "@/lib/compare-data";
import { prisma } from "@/lib/db";
import type { ScrapingStatus } from "@/lib/types";
import { SCRAPING_STATUS_LABELS } from "@/lib/types";
import type { Metadata } from "next";
import Link from "next/link";

type Params = Promise<{ weekNum: string; trackId: string; carId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pickInt(v: string | string[] | undefined): number | undefined {
  if (!v) return undefined;
  const s = Array.isArray(v) ? v[0] : v;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

function pickString(v: string | string[] | undefined): string | undefined {
  if (!v) return undefined;
  const s = Array.isArray(v) ? v[0] : v;
  return s.trim() || undefined;
}

function formatLapTime(seconds: number | null | undefined): string {
  if (seconds == null) return "";
  const m = Math.floor(seconds / 60);
  const s = (seconds - m * 60).toFixed(3);
  return m > 0 ? `${m}:${s.padStart(6, "0")}` : `${s}s`;
}

function formatPrice(p: number | null | undefined): string {
  if (p == null) return "";
  return `$${p.toFixed(2)}`;
}

const STATUS_DOT: Record<ScrapingStatus, string> = {
  SCRAPED: "bg-emerald-500",
  AUTH_SCRAPED: "bg-teal-400",
  LOGIN_WALLED: "bg-amber-500",
  CLOUDFLARE_BLOCKED: "bg-rose-500",
  API_LOCKED: "bg-rose-500",
};

const SCRAPED_STATUSES: ScrapingStatus[] = ["SCRAPED", "AUTH_SCRAPED"];

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { weekNum, trackId, carId } = await params;
  const [car, track] = await Promise.all([
    prisma.car.findUnique({ where: { id: parseInt(carId, 10) }, select: { name: true } }),
    prisma.track.findUnique({ where: { id: parseInt(trackId, 10) }, select: { name: true } }),
  ]);
  const carName = car?.name ?? `Car ${carId}`;
  const trackName = track?.name ?? `Track ${trackId}`;
  return {
    title: `${carName} · ${trackName} · Week ${weekNum} -- iRacing Setup Comparison`,
  };
}

export default async function CarPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { weekNum: weekNumStr, trackId: trackIdStr, carId: carIdStr } = await params;
  const sp = await searchParams;

  const weekNum = parseInt(weekNumStr, 10);
  const trackId = parseInt(trackIdStr, 10);
  const carId = parseInt(carIdStr, 10);
  const seasonId = pickInt(sp.seasonId);
  const carClass = pickString(sp.carClass);

  const data = await getTrackCompareData(
    Number.isFinite(weekNum) ? weekNum : 0,
    Number.isFinite(trackId) ? trackId : 0,
    { seasonId, carClass }
  );

  const carRow = data.rows.find((r) => r.carId === carId);

  // Resolve track name even when the row is missing (invalid carId in URL).
  const trackName =
    carRow?.trackName ??
    (await prisma.track
      .findUnique({ where: { id: trackId }, select: { name: true } })
      .then((t) => t?.name ?? `Track ${trackId}`));

  // Build the back-link preserving filter + sort state from the querystring.
  const backQs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") backQs.set(k, v);
    else if (Array.isArray(v) && v[0]) backQs.set(k, v[0]);
  }
  const backTail = backQs.toString();
  const backHref = `/week/${weekNum}/track/${trackId}${backTail ? `?${backTail}` : ""}`;

  if (!carRow || !Number.isFinite(carId)) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-4">
        <div className="text-sm text-gray-500">
          <Link href={backHref} className="hover:text-gray-300 transition-colors">
            &larr; Back to {trackName}
          </Link>
        </div>
        <p className="text-gray-400">No setups found for this car at this track and week.</p>
      </div>
    );
  }

  // Pair each shop descriptor with its cell so we render them in stable shop-id order.
  const sections = data.shops.map((shop) => {
    const cell = carRow.cells.find((c) => c.shopId === shop.id);
    return { shop, cell };
  });

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <header className="space-y-1">
        <div className="text-sm text-gray-500">
          <Link href={backHref} className="hover:text-gray-300 transition-colors">
            &larr; Back to {trackName}
          </Link>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">{carRow.carName}</h1>
        <p className="text-sm text-gray-400">
          Week {weekNum} &middot; {trackName}
        </p>
        <span className="inline-block mt-1 px-2 py-0.5 rounded text-xs font-medium bg-gray-800 text-gray-300 border border-gray-700">
          {carRow.carClass}
        </span>
      </header>

      <div className="space-y-4">
        {sections.map(({ shop, cell }) => {
          const isScraped = SCRAPED_STATUSES.includes(shop.scrapingStatus);
          const hasData = !!cell?.url;
          const isGnG = shop.name === "Grid-and-Go";

          return (
            <div
              key={shop.id}
              className="rounded-md border border-gray-800 bg-gray-900/50 px-5 py-4 space-y-3"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${STATUS_DOT[shop.scrapingStatus]}`}
                  aria-hidden="true"
                />
                <h2 className="font-semibold text-gray-100">{shop.name}</h2>
                {!isScraped && (
                  <span className="text-xs text-gray-500 italic">
                    {SCRAPING_STATUS_LABELS[shop.scrapingStatus]}
                  </span>
                )}
              </div>

              {hasData && cell ? (
                <div className="space-y-2">
                  {cell.lapTimeSeconds != null && (
                    <div className="text-2xl font-mono font-semibold text-emerald-400">
                      {formatLapTime(cell.lapTimeSeconds)}
                    </div>
                  )}

                  {cell.price != null && shop.name !== "P1Doks" && (
                    <div className="text-sm text-gray-400">
                      {formatPrice(cell.price)}
                    </div>
                  )}

                  {isGnG && (() => {
                    const m = cell.url?.match(/\/datapacks\/([a-zA-Z0-9_-]+)/i);
                    const datapackId = m?.[1] ?? null;
                    if (!datapackId) return null;
                    return (
                      <div className="border-t border-gray-800 pt-2 space-y-2">
                        <div className="flex flex-wrap items-center gap-3">
                          <a
                            href={`/admin/files/${datapackId}`}
                            className="text-sm text-blue-300 hover:text-blue-200 underline-offset-2 hover:underline"
                          >
                            Browse setup files (admin login required) &#x2197;
                          </a>
                          <a
                            href={`/api/files/${datapackId}/zip`}
                            className="text-sm text-emerald-400 hover:text-emerald-300 underline-offset-2 hover:underline"
                          >
                            Download all (.zip)
                          </a>
                        </div>
                        <p className="text-xs text-gray-600">
                          First download warms the cache (~10s); subsequent downloads are instant.
                        </p>
                      </div>
                    );
                  })()}

                  <a
                    href={cell.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded bg-blue-700 hover:bg-blue-600 transition-colors px-3 py-1.5 text-sm font-medium text-white"
                  >
                    Open setup ↗
                  </a>
                </div>
              ) : (
                <p className="text-sm text-gray-600 italic">
                  No setup for this combination.
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
