type FilterData = {
  seasons: { id: number; year: number; quarter: number; label: string }[];
  carClasses: string[];
  selectedSeasonId: number | null;
  selectedCarClass: string | null;
};

type Props = {
  data: FilterData;
  /** Defaults to "/" — pass the current path for week/track pages. */
  action?: string;
  /** Preserved across filter submissions so sort survives a class change. */
  sortBy?: string | null;
  sortDir?: "asc" | "desc" | null;
  /** When true, hides the Season select (e.g. on the track detail page). */
  hideSeason?: boolean;
};

/**
 * Server-rendered GET form — submits with query params.
 * No client JS, no useState. Selecting + Apply navigates.
 * Week and Track come from the URL path on sub-pages, not this form.
 */
export function CompareFilters({ data, action = "/", sortBy, sortDir, hideSeason = false }: Props) {
  return (
    <form
      method="get"
      action={action}
      className={`grid grid-cols-1 sm:grid-cols-2 gap-3 items-end rounded-md border border-gray-800 bg-gray-900/40 p-4 ${hideSeason ? "lg:grid-cols-2" : "lg:grid-cols-3"}`}
    >
      {!hideSeason && (
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
      )}

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

      <button
        type="submit"
        className="rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 transition-colors"
      >
        Apply
      </button>
      {sortBy && <input type="hidden" name="sortBy" value={sortBy} />}
      {sortBy && sortDir && <input type="hidden" name="sortDir" value={sortDir} />}
    </form>
  );
}
