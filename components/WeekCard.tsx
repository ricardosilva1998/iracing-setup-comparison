import Link from "next/link";
import type { WeekSummary } from "@/lib/compare-data";

type Props = {
  week: WeekSummary;
  href: string;
};

export function WeekCard({ week, href }: Props) {
  const empty = week.setupCount === 0;
  return (
    <Link
      href={href}
      className={[
        "rounded-md border border-gray-800 bg-gray-900/60 p-5 flex flex-col gap-1",
        "transition-transform transition-shadow duration-150",
        empty
          ? "opacity-40 pointer-events-none"
          : "hover:-translate-y-0.5 hover:shadow-md hover:border-gray-700 hover:bg-gray-900/80",
      ].join(" ")}
      tabIndex={empty ? -1 : undefined}
      aria-disabled={empty}
    >
      <span className="text-xl font-bold text-gray-100">{week.label}</span>
      <span className="text-sm text-gray-400">
        {week.setupCount.toLocaleString()} setup{week.setupCount !== 1 ? "s" : ""}
      </span>
    </Link>
  );
}
