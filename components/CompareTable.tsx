import type { CompareRow, CompareCell, ScrapingStatus } from "@/lib/types";
import { SCRAPING_STATUS_LABELS } from "@/lib/types";
import { shopNameToSlug } from "@/lib/shop-slug";

type Props = {
  rows: CompareRow[];
  shops: { id: number; name: string; scrapingStatus: ScrapingStatus }[];
  hideTrackColumn?: boolean;
  /** The shop slug currently used as the sort key (matches /api/ingest ?shop= enum). */
  sortBy?: string | null;
  sortDir?: "asc" | "desc" | null;
  /** Called with the target shop slug; returns the href for the next sort state. */
  buildSortHref?: (slug: string) => string;
};

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

const SCRAPED_STATUSES: ScrapingStatus[] = ["SCRAPED", "AUTH_SCRAPED"];

function Cell({ cell }: { cell: CompareCell }) {
  if (!cell.url) {
    if (!SCRAPED_STATUSES.includes(cell.scrapingStatus)) {
      return (
        <td className="border border-gray-800 px-3 py-2 text-gray-600 text-xs italic">
          {SCRAPING_STATUS_LABELS[cell.scrapingStatus]}
        </td>
      );
    }
    return (
      <td className="border border-gray-800 px-3 py-2 text-gray-600 text-center">--</td>
    );
  }

  return (
    <td className="border border-gray-800 px-3 py-2 align-top">
      <a
        href={cell.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-400 hover:text-blue-300 underline-offset-2 hover:underline text-sm font-medium block"
      >
        Open setup
      </a>
      <div className="mt-1 flex flex-wrap gap-2 text-xs text-gray-400">
        {cell.price != null && cell.shopName !== "P1Doks" && (
          <span>{formatPrice(cell.price)}</span>
        )}
        {cell.lapTimeSeconds != null && (
          <span className="text-emerald-400">
            {formatLapTime(cell.lapTimeSeconds)}
          </span>
        )}
      </div>
    </td>
  );
}

export function CompareTable({
  rows,
  shops,
  hideTrackColumn = false,
  sortBy = null,
  sortDir = null,
  buildSortHref,
}: Props) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-gray-700 p-8 text-center text-gray-400 text-sm">
        No setup listings match the current filters.
        <div className="mt-2 text-xs text-gray-500">
          Most shops are not scrapeable -- run <code className="text-gray-300">npm run scrape:hymo</code>{" "}
          to refresh HYMO data, then re-apply filters.
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-gray-800">
      <table className="w-full text-sm">
        <thead className="bg-gray-900/60 text-left text-xs uppercase tracking-wide text-gray-400">
          <tr>
            <th className="border border-gray-800 px-3 py-2 sticky left-0 bg-gray-900/60 z-10">
              Car
            </th>
            <th className="border border-gray-800 px-3 py-2">Class</th>
            {!hideTrackColumn && (
              <th className="border border-gray-800 px-3 py-2">Track</th>
            )}
            {shops.map((s) => {
              const slug = shopNameToSlug(s.name);
              const isActive = sortBy === slug;
              const indicator = isActive
                ? sortDir === "asc"
                  ? "↑"
                  : "↓"
                : "↕";
              return (
                <th key={s.id} className="border border-gray-800 px-3 py-2">
                  <div className="flex items-center gap-1">
                    <span>{s.name}</span>
                    {buildSortHref && (
                      <a
                        href={buildSortHref(slug)}
                        className={
                          isActive
                            ? "text-blue-400 hover:text-blue-300 text-[11px] font-mono leading-none"
                            : "text-gray-500 hover:text-gray-200 text-[11px] font-mono leading-none"
                        }
                        aria-label={`Sort by ${s.name} lap time`}
                      >
                        {indicator}
                      </a>
                    )}
                  </div>
                  {!SCRAPED_STATUSES.includes(s.scrapingStatus) && (
                    <div className="text-[10px] normal-case text-amber-400 font-normal">
                      {SCRAPING_STATUS_LABELS[s.scrapingStatus]}
                    </div>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.carId}:${r.trackId}`} className="hover:bg-gray-900/40">
              <td className="border border-gray-800 px-3 py-2 font-medium text-gray-100 sticky left-0 bg-gray-950 z-10">
                {r.carName}
              </td>
              <td className="border border-gray-800 px-3 py-2 text-gray-300">
                {r.carClass}
              </td>
              {!hideTrackColumn && (
                <td className="border border-gray-800 px-3 py-2 text-gray-300">
                  {r.trackName}
                </td>
              )}
              {r.cells.map((cell) => (
                <Cell key={cell.shopId} cell={cell} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
