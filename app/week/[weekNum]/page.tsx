import { CompareFilters } from "@/components/CompareFilters";
import { TrackCard } from "@/components/TrackCard";
import { getTrackList } from "@/lib/compare-data";
import type { Metadata } from "next";
import Link from "next/link";

type Params = Promise<{ weekNum: string }>;
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

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { weekNum } = await params;
  return { title: `Week ${weekNum} -- iRacing Setup Comparison` };
}

export default async function WeekPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { weekNum: weekNumStr } = await params;
  const sp = await searchParams;

  const weekNum = parseInt(weekNumStr, 10);
  const seasonId = pickInt(sp.seasonId);
  const carClass = pickString(sp.carClass);

  const data = await getTrackList(Number.isFinite(weekNum) ? weekNum : 0, {
    seasonId,
    carClass,
  });

  const backQs = new URLSearchParams();
  if (data.selectedSeasonId) backQs.set("seasonId", String(data.selectedSeasonId));
  if (data.selectedCarClass) backQs.set("carClass", data.selectedCarClass);
  const backTail = backQs.toString();
  const backHref = backTail ? `/?${backTail}` : "/";

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <header className="space-y-1">
        <div className="text-sm text-gray-500">
          <Link href={backHref} className="hover:text-gray-300 transition-colors">
            &larr; All weeks
          </Link>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">{data.weekLabel}</h1>
        <p className="text-sm text-gray-400">
          Select a track to compare setups across shops.
        </p>
      </header>

      <CompareFilters data={data} action={`/week/${weekNum}`} />

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {[...data.tracks]
          .sort((a, b) => {
            const aHas = a.setupCount > 0 ? 0 : 1;
            const bHas = b.setupCount > 0 ? 0 : 1;
            if (aHas !== bHas) return aHas - bHas;
            return a.name.localeCompare(b.name);
          })
          .map((track) => {
            const qs = new URLSearchParams();
            if (data.selectedSeasonId) qs.set("seasonId", String(data.selectedSeasonId));
            if (data.selectedCarClass) qs.set("carClass", data.selectedCarClass);
            const tail = qs.toString();
            const href = tail
              ? `/week/${weekNum}/track/${track.id}?${tail}`
              : `/week/${weekNum}/track/${track.id}`;
            return <TrackCard key={track.id} track={track} href={href} />;
          })}
      </div>
    </div>
  );
}
