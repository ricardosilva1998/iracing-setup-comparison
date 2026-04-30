import Link from "next/link";

export default function Home() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 space-y-8">
      <section>
        <h1 className="text-3xl font-bold tracking-tight">
          iRacing Setup Comparison
        </h1>
        <p className="mt-3 text-gray-300 leading-relaxed">
          A side-by-side view of which iRacing setup shops sell a setup for a
          given car, track, and season week. The goal: stop tab-flipping
          between four shops to find one for the combo you actually need.
        </p>
      </section>

      <section className="rounded-md border border-gray-800 bg-gray-900/40 p-5 text-sm text-gray-300 space-y-3">
        <h2 className="text-base font-semibold text-gray-100">
          What this MVP shows
        </h2>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <span className="font-medium text-gray-100">HYMO Setups</span>,{" "}
            <span className="font-medium text-gray-100">GO Setups</span>, and{" "}
            <span className="font-medium text-gray-100">Majors Garage</span> --
            scraped from public catalogs / APIs (rate-limited, robots.txt
            respected).
          </li>
          <li>
            <span className="font-medium text-gray-100">Grid-and-Go</span> --
            authenticated scrape via the user&apos;s own paid Plus
            subscription, run with the user&apos;s explicit consent.
          </li>
          <li>
            <span className="font-medium text-gray-100">P1Doks</span> -- listed
            but not scraped. Catalog sits behind an authenticated API; the
            column appears as a labelled empty-state until we have a
            legitimate data path.
          </li>
          <li>
            Lap-time signals are sparse -- none of these shops publish a
            "fastest time" feed. The schema supports lap times but the table
            stays mostly empty until we wire the iRacing API or driver
            submissions.
          </li>
        </ul>
      </section>

      <section>
        <Link
          href="/compare"
          className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
        >
          Open the comparison table
        </Link>
      </section>
    </div>
  );
}
