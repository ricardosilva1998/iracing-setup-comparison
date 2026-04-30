/**
 * Bidirectional mapping between URL-safe shop slugs and shop display names.
 * Slugs must match the ?shop= enum in /api/ingest/route.ts exactly.
 */

const SLUG_TO_NAME: Record<string, string> = {
  hymo: "HYMO Setups",
  "grid-and-go": "Grid-and-Go",
  gosetups: "GO Setups",
  "majors-garage": "Majors Garage",
  p1doks: "P1Doks",
};

const NAME_TO_SLUG: Record<string, string> = Object.fromEntries(
  Object.entries(SLUG_TO_NAME).map(([slug, name]) => [name, slug]),
);

/** Returns the display name for a slug, or null if the slug is unknown. */
export function slugToShopName(slug: string): string | null {
  return SLUG_TO_NAME[slug] ?? null;
}

/** Returns the slug for a shop display name, or the name itself as a fallback. */
export function shopNameToSlug(name: string): string {
  return NAME_TO_SLUG[name] ?? name;
}
