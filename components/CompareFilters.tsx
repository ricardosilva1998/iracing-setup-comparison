import type { CompareData } from "@/lib/compare-data";

type Props = {
  data: CompareData;
};

/**
 * Server-rendered GET form -- submits to /compare with query params.
 * No client JS, no useState. Selecting + Apply navigates.
 */
export function CompareFilters({ data }: Props) {
  return (
    <form
      method="get"
      action="/"
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end rounded-md border border-gray-800 bg-gray-900/40 p-4"
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-gray-400">Season</span>
        <select
          name="seasonId"
          defaultValue={data.selectedSeasonId ?? ""}
          className="bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-gray-100"
        >
          {data.seasons.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-gray-400">Class</span>
        <select
          name="carClass"
          defaultValue={data.selectedCarClass ?? ""}
          className="bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-gray-100"
        >
          <option value="">All classes</option>
          {data.carClasses.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-gray-400">Track</span>
        <select
          name="trackId"
          defaultValue={data.selectedTrackId ?? ""}
          className="bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-gray-100"
        >
          <option value="">Any track</option>
          {data.tracks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-gray-400">Week</span>
        <select
          name="weekNum"
          defaultValue={data.selectedWeekNum ?? ""}
          className="bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-gray-100"
        >
          <option value="">Any week</option>
          {data.weeks.map((w) => (
            <option key={w.id} value={w.weekNum}>
              {w.label}
            </option>
          ))}
        </select>
      </label>

      <button
        type="submit"
        className="rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 transition-colors"
      >
        Apply
      </button>
    </form>
  );
}
