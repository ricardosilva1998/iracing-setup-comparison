import { CompareFilters } from "@/components/CompareFilters";
import { CompareTable } from "@/components/CompareTable";
import { ScrapingLegend } from "@/components/ScrapingLegend";
import { getCompareData } from "@/lib/compare-data";
import { prisma } from "@/lib/db";
import type { Metadata } from "next";
import type { ScrapingStatus } from "@/lib/types";

export const metadata: Metadata = {
  title: "Compare setups -- iRacing Setup Comparison",
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

  const data = await getCompareData({
    seasonId: pickInt(sp.seasonId),
    carClass: pickString(sp.carClass),
    weekNum: pickInt(sp.weekNum),
    trackId: pickInt(sp.trackId),
  });

  // Pull notes for the legend (kept out of CompareData to avoid widening it).
  const shopRows = await prisma.shop.findMany({ orderBy: { id: "asc" } });
  const shopsWithNotes = shopRows.map((s) => ({
    id: s.id,
    name: s.name,
    scrapingStatus: s.scrapingStatus as ScrapingStatus,
    notes: s.notes,
  }));

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">
          Setup comparison
        </h1>
        <p className="text-sm text-gray-400 max-w-3xl">
          One row per (car, track) pair that any tracked shop sells. Cells
          link to the shop&apos;s product page; if a price or lap time was
          published, you&apos;ll see it inline. Shops behind login or
          Cloudflare are surfaced as labelled empty cells -- see the legend
          below.
        </p>
      </header>

      <CompareFilters data={data} />

      <CompareTable rows={data.rows} shops={data.shops} />

      <ScrapingLegend shops={shopsWithNotes} />
    </div>
  );
}
