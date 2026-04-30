import { CompareFilters } from "@/components/CompareFilters";
import { WeekCard } from "@/components/WeekCard";
import { getWeekList } from "@/lib/compare-data";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Pick a week -- iRacing Setup Comparison",
};

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

export default async function HomePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;

  // Legacy URL support: /?weekNum=N redirects to /week/N preserving other params.
  const weekNum = pickInt(sp.weekNum);
  if (weekNum !== undefined) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (k === "weekNum" || k === "trackId") continue;
      if (typeof v === "string") qs.set(k, v);
      else if (Array.isArray(v) && v[0]) qs.set(k, v[0]);
    }
    const tail = qs.toString();
    redirect(tail ? `/week/${weekNum}?${tail}` : `/week/${weekNum}`);
  }

  const seasonId = pickInt(sp.seasonId);
  const carClass = pickString(sp.carClass);

  const data = await getWeekList({ seasonId, carClass });

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Pick a week</h1>
        <p className="text-sm text-gray-400">
          Select a season week to see which tracks are covered, then dive into
          the shop comparison for any track.
        </p>
      </header>

      <CompareFilters data={data} action="/" />

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {data.weeks.map((week) => {
          const qs = new URLSearchParams();
          if (data.selectedSeasonId) qs.set("seasonId", String(data.selectedSeasonId));
          if (data.selectedCarClass) qs.set("carClass", data.selectedCarClass);
          const tail = qs.toString();
          const href = tail ? `/week/${week.weekNum}?${tail}` : `/week/${week.weekNum}`;
          return <WeekCard key={week.id} week={week} href={href} />;
        })}
      </div>
    </div>
  );
}
