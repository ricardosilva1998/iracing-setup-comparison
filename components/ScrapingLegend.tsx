import type { ScrapingStatus } from "@/lib/types";
import { SCRAPING_STATUS_LABELS } from "@/lib/types";

type Props = {
  shops: { id: number; name: string; scrapingStatus: ScrapingStatus; notes?: string | null }[];
};

const STATUS_DOT: Record<ScrapingStatus, string> = {
  SCRAPED: "bg-emerald-500",
  AUTH_SCRAPED: "bg-emerald-500",
  LOGIN_WALLED: "bg-amber-500",
  CLOUDFLARE_BLOCKED: "bg-rose-500",
  API_LOCKED: "bg-rose-500",
};

export function ScrapingLegend({ shops }: Props) {
  return (
    <section className="mt-6 rounded-md border border-gray-800 bg-gray-900/30 p-4">
      <h3 className="text-sm font-semibold text-gray-200 mb-2">
        Scraping status
      </h3>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm text-gray-300">
        {shops.map((s) => (
          <li key={s.id} className="flex items-start gap-2">
            <span
              className={`mt-1.5 inline-block w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[s.scrapingStatus]}`}
              aria-hidden="true"
            />
            <div className="flex flex-col">
              <span>
                <span className="text-gray-100 font-medium">{s.name}</span>
                <span className="text-gray-400"> -- {SCRAPING_STATUS_LABELS[s.scrapingStatus]}</span>
              </span>
              {s.notes && (
                <span className="text-xs text-gray-500">{s.notes}</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
