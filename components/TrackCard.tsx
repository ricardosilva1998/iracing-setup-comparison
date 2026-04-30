import Link from "next/link";
import type { TrackSummary } from "@/lib/compare-data";

type Props = {
  track: TrackSummary;
  href: string;
};

export function TrackCard({ track, href }: Props) {
  const empty = track.setupCount === 0;
  return (
    <Link
      href={href}
      className={[
        "rounded-md border border-gray-800 bg-gray-900/60 p-4 flex flex-col gap-1",
        "transition-transform transition-shadow duration-150",
        empty
          ? "opacity-40 pointer-events-none"
          : "hover:-translate-y-0.5 hover:shadow-md hover:border-gray-700 hover:bg-gray-900/80",
      ].join(" ")}
      tabIndex={empty ? -1 : undefined}
      aria-disabled={empty}
    >
      <span className="text-sm font-semibold text-gray-100 leading-snug">
        {track.name}
      </span>
      <span className="text-xs text-gray-400">
        {track.setupCount.toLocaleString()} setup{track.setupCount !== 1 ? "s" : ""}
      </span>
    </Link>
  );
}
