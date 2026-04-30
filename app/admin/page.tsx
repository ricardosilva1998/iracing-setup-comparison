import { ScrapingLegend } from "@/components/ScrapingLegend";
import { getScrapingStatusList, getRecentScrapeRuns } from "@/lib/admin-data";
import { prisma } from "@/lib/db";
import type { ScrapingStatus } from "@/lib/types";

function formatDuration(startedAt: Date, finishedAt: Date | null): string {
  if (!finishedAt) return "--";
  const ms = finishedAt.getTime() - startedAt.getTime();
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatDate(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

const RUN_STATUS_CLASS: Record<string, string> = {
  OK: "text-emerald-400",
  FAILED: "text-rose-400",
  PARTIAL: "text-amber-400",
};

export default async function AdminPage() {
  const [statusList, recentRuns, carCount, trackCount] = await Promise.all([
    getScrapingStatusList(),
    getRecentScrapeRuns(20),
    prisma.car.count(),
    prisma.track.count(),
  ]);

  const totalListings = statusList.reduce((sum, s) => sum + s.listingCount, 0);
  const totalLapTimes = statusList.reduce((sum, s) => sum + s.lapTimeCount, 0);

  const legendShops = statusList.map((s) => ({
    id: s.id,
    name: s.name,
    scrapingStatus: s.scrapingStatus as ScrapingStatus,
    notes: s.notes,
  }));

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Admin dashboard</h1>
        <p className="text-sm text-gray-400">Scraping status and recent ingest runs.</p>
      </header>

      {/* Totals */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: "Setup listings", value: totalListings },
          { label: "Lap times", value: totalLapTimes },
          { label: "Cars", value: carCount },
          { label: "Tracks", value: trackCount },
        ].map(({ label, value }) => (
          <div
            key={label}
            className="rounded-md border border-gray-800 bg-gray-900/40 p-4 text-center"
          >
            <div className="text-2xl font-bold text-gray-100">{value.toLocaleString()}</div>
            <div className="text-xs text-gray-400 mt-1">{label}</div>
          </div>
        ))}
      </div>

      {/* Scraping status */}
      <section className="space-y-2">
        <h2 className="text-base font-semibold text-gray-200">Shops</h2>
        <ScrapingLegend shops={legendShops} />
      </section>

      {/* Per-shop listing counts */}
      <section className="space-y-2">
        <h2 className="text-base font-semibold text-gray-200">Listing counts per shop</h2>
        <div className="rounded-md border border-gray-800 bg-gray-900/40 overflow-x-auto">
          <table className="min-w-full text-sm text-gray-300">
            <thead>
              <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wider">
                <th className="px-4 py-2 text-left">Shop</th>
                <th className="px-4 py-2 text-right">Listings</th>
                <th className="px-4 py-2 text-right">Lap times</th>
              </tr>
            </thead>
            <tbody>
              {statusList.map((s) => (
                <tr key={s.id} className="border-b border-gray-800/50 last:border-0">
                  <td className="px-4 py-2 font-medium text-gray-100">{s.name}</td>
                  <td className="px-4 py-2 text-right">{s.listingCount.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right">{s.lapTimeCount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recent scrape runs */}
      <section className="space-y-2">
        <h2 className="text-base font-semibold text-gray-200">Recent scrape runs</h2>
        {recentRuns.length === 0 ? (
          <p className="text-sm text-gray-500 rounded-md border border-gray-800 bg-gray-900/40 p-4">
            No scrape runs recorded yet.
          </p>
        ) : (
          <div className="rounded-md border border-gray-800 bg-gray-900/40 overflow-x-auto">
            <table className="min-w-full text-sm text-gray-300">
              <thead>
                <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wider">
                  <th className="px-4 py-2 text-left whitespace-nowrap">When</th>
                  <th className="px-4 py-2 text-left">Shop</th>
                  <th className="px-4 py-2 text-left">Status</th>
                  <th className="px-4 py-2 text-right">Duration</th>
                  <th className="px-4 py-2 text-right">Fetched</th>
                  <th className="px-4 py-2 text-right">Inserted</th>
                  <th className="px-4 py-2 text-right">Updated</th>
                  <th className="px-4 py-2 text-right">Errors</th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.map((run) => (
                  <tr key={run.id} className="border-b border-gray-800/50 last:border-0">
                    <td className="px-4 py-2 whitespace-nowrap text-gray-400 text-xs">
                      {formatDate(run.startedAt)}
                    </td>
                    <td className="px-4 py-2 font-medium text-gray-100 whitespace-nowrap">
                      {run.shopName}
                    </td>
                    <td className={`px-4 py-2 font-medium ${RUN_STATUS_CLASS[run.status] ?? "text-gray-300"}`}>
                      {run.status}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-400">
                      {formatDuration(run.startedAt, run.finishedAt)}
                    </td>
                    <td className="px-4 py-2 text-right">{run.fetched}</td>
                    <td className="px-4 py-2 text-right">{run.inserted}</td>
                    <td className="px-4 py-2 text-right">{run.updated}</td>
                    <td className="px-4 py-2 text-right">
                      {run.error ? (
                        <span className="text-rose-400" title={run.error}>
                          1
                        </span>
                      ) : (
                        <span className="text-gray-500">0</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
