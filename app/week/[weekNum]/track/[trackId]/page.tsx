import { CompareFilters } from "@/components/CompareFilters";
import { CompareTable } from "@/components/CompareTable";
import { ScrapingLegend } from "@/components/ScrapingLegend";
import { getTrackCompareData } from "@/lib/compare-data";
import { prisma } from "@/lib/db";
import type { Metadata } from "next";
import type { ScrapingStatus } from "@/lib/types";
import Link from "next/link";

type Params = Promise<{ weekNum: string; trackId: string }>;
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

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { weekNum, trackId } = await params;
  const track = await prisma.track.findUnique({
    where: { id: parseInt(trackId, 10) },
    select: { name: true },
  });
  const name = track?.name ?? `Track ${trackId}`;
  return { title: `${name} — Week ${weekNum} -- iRacing Setup Comparison` };
}

export default async function TrackPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { weekNum: weekNumStr, trackId: trackIdStr } = await params;
  const sp = await searchParams;

  const weekNum = parseInt(weekNumStr, 10);
  const trackId = parseInt(trackIdStr, 10);
  const seasonId = pickInt(sp.seasonId);
  const carClass = pickString(sp.carClass);

  const data = await getTrackCompareData(
    Number.isFinite(weekNum) ? weekNum : 0,
    Number.isFinite(trackId) ? trackId : 0,
    { seasonId, carClass }
  );

  // Resolve track name from rows first; fall back to a direct DB lookup so
  // the header is correct even when no listings exist for the current filter.
  const trackName =
    data.rows[0]?.trackName ??
    (await prisma.track
      .findUnique({ where: { id: trackId }, select: { name: true } })
      .then((t) => t?.name ?? `Track ${trackId}`));

  const shopRows = await prisma.shop.findMany({ orderBy: { id: "asc" } });
  const shopsWithNotes = shopRows.map((s) => ({
    id: s.id,
    name: s.name,
    scrapingStatus: s.scrapingStatus as ScrapingStatus,
    notes: s.notes,
  }));

  const backQs = new URLSearchParams();
  if (data.selectedSeasonId) backQs.set("seasonId", String(data.selectedSeasonId));
  if (data.selectedCarClass) backQs.set("carClass", data.selectedCarClass);
  const backTail = backQs.toString();
  const backHref = backTail ? `/week/${weekNum}?${backTail}` : `/week/${weekNum}`;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <header className="space-y-1">
        <div className="text-sm text-gray-500">
          <Link href={backHref} className="hover:text-gray-300 transition-colors">
            &larr; Week {weekNum}
          </Link>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">{trackName}</h1>
        <p className="text-sm text-gray-400">
          Cars available from each shop this week at this track.
        </p>
      </header>

      <CompareFilters
        data={data}
        action={`/week/${weekNum}/track/${trackId}`}
      />

      <CompareTable rows={data.rows} shops={data.shops} hideTrackColumn />

      <ScrapingLegend shops={shopsWithNotes} />
    </div>
  );
}
