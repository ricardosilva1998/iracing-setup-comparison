/**
 * Canonical car-class lookup.
 *
 * Round 3 fix: HYMO and Grid-and-Go disagreed about how to label car class.
 * HYMO labels by *real car class* (GT3, GTP/LMDh, LMP2, GT4, ...).
 * Grid-and-Go was inadvertently labeled by *race series* (DTM, ENDURANCE,
 * FIXED, GTP, ...), which fragmented the same physical car (e.g. "Ferrari
 * 296 GT3") into 5 rows under different classes. The /compare page then
 * showed five rows for one car instead of one row with both shops side-by-side.
 *
 * This module produces ONE canonical class per car name. Strategy:
 *
 *   1. If we already have a HYMO row for that car name in the DB, use that
 *      class (HYMO's taxonomy is the reference -- they label by real class).
 *   2. Otherwise, infer from the car name itself with regex on common
 *      suffixes / brand patterns. This catches the GnG-only cars (BMW M2 CS
 *      Racing, Ford GT GT2, Skip Barber Formula 2000, ...).
 *   3. Final fallback for unknown names: return the supplied default so we
 *      never silently drop a car (the caller passes the GnG series, last-resort).
 *
 * The regex layer is intentionally narrow -- we only match patterns we've
 * verified against the actual catalogs. Adding new ones is a small,
 * reviewable diff.
 */
import type { PrismaClient } from "../app/generated/prisma/client";

// ---- canonical class strings (single source of truth) ------------------
// Keep these stable -- they are what the /compare filter dropdown shows.
export const CANONICAL_CLASSES = {
  GT3: "GT3",
  GT4: "GT4",
  GTE: "GTE",
  GT2: "GT2",
  GTP_LMDH: "GTP/LMDh",
  LMP2: "LMP2",
  LMP3: "LMP3",
  TCR: "TCR",
  PCUP: "PCUP",        // Porsche Mission R / 992 cup car (HYMO's PCUP)
  PCC: "PCC",          // Production-Car Challenge (Mazda MX-5, Toyota GR86, ...)
  FORMULA: "Formula",  // catch-all for open-wheel cars
  PRODUCTION: "Production",
  ROAD: "Road",
} as const;

// ---- name-pattern -> class -------------------------------------------------
// Order matters: more specific patterns first.
// Each entry: regex tested against the car's full name (case-insensitive).
type NameRule = { match: RegExp; carClass: string };
const NAME_RULES: NameRule[] = [
  // GTP / LMDh prototypes (Cadillac V-Series.R, Acura ARX-06, BMW M Hybrid V8,
  // Porsche 963, Ferrari 499P, ...). Look for "GTP", "Hybrid", "499P", "963",
  // "ARX-06", "V-Series.R".
  { match: /\b(GTP|LMDh)\b/i,                           carClass: CANONICAL_CLASSES.GTP_LMDH },
  { match: /\bM Hybrid V8\b/i,                          carClass: CANONICAL_CLASSES.GTP_LMDH },
  { match: /\b499P\b/i,                                 carClass: CANONICAL_CLASSES.GTP_LMDH },
  { match: /\b963\b/i,                                  carClass: CANONICAL_CLASSES.GTP_LMDH },
  { match: /\bARX-?0?6\b/i,                             carClass: CANONICAL_CLASSES.GTP_LMDH },
  { match: /\bV-Series\.?R\b/i,                         carClass: CANONICAL_CLASSES.GTP_LMDH },

  // LMP2 / LMP3 (Dallara P217 = LMP2, Ligier JS P320 = LMP3).
  { match: /\b(P217|LMP2)\b/i,                          carClass: CANONICAL_CLASSES.LMP2 },
  { match: /\b(P320|LMP3)\b/i,                          carClass: CANONICAL_CLASSES.LMP3 },

  // GT classes -- check GT2 / GTE / GT4 before generic GT3.
  { match: /\bGT2\b/i,                                  carClass: CANONICAL_CLASSES.GT2 },
  { match: /\bGTE\b/i,                                  carClass: CANONICAL_CLASSES.GTE },
  { match: /\bGT4\b/i,                                  carClass: CANONICAL_CLASSES.GT4 },
  { match: /\bGT3\b/i,                                  carClass: CANONICAL_CLASSES.GT3 },

  // TCR.
  { match: /\bTCR\b/i,                                  carClass: CANONICAL_CLASSES.TCR },

  // Porsche Cup family.
  // Porsche 911 Cup (992.2) / 992 Cup -> PCUP (HYMO uses PCUP for the Mission R / 992 cup).
  { match: /\bPorsche 911 Cup\b/i,                      carClass: CANONICAL_CLASSES.PCUP },
  { match: /\bMission R\b/i,                            carClass: CANONICAL_CLASSES.PCUP },

  // Production-Car Challenge (Mazda MX-5, Toyota GR86, ...). HYMO calls this PCC.
  { match: /\bMX-?5\b/i,                                carClass: CANONICAL_CLASSES.PCC },
  { match: /\bGR86\b/i,                                 carClass: CANONICAL_CLASSES.PCC },

  // Open-wheel / formula -- HYMO labels these "Single Seaters".
  // Single Seaters (Dallara F3, Super Formula Lights, FIA F4, Skip Barber, Ray FF1600, IL-15, ...).
  { match: /\bSkip Barber\b/i,                          carClass: CANONICAL_CLASSES.FORMULA },
  { match: /\bSuper Formula\b/i,                        carClass: CANONICAL_CLASSES.FORMULA },
  { match: /\bRay FF1600\b/i,                           carClass: CANONICAL_CLASSES.FORMULA },
  { match: /\b(F3|F4|FIA F4)\b/i,                       carClass: CANONICAL_CLASSES.FORMULA },
  { match: /\bIL-?15\b/i,                               carClass: CANONICAL_CLASSES.FORMULA },
  { match: /\bFormula\b/i,                              carClass: CANONICAL_CLASSES.FORMULA },

  // Production (BMW M2 CS Racing, Pontiac Solstice, Kia Optima, Street Stock, Ferrari 296 Challenge).
  { match: /\bM2 CS Racing\b/i,                         carClass: CANONICAL_CLASSES.PRODUCTION },
  { match: /\bChallenge\b/i,                            carClass: CANONICAL_CLASSES.PRODUCTION },
  { match: /\bStreet Stock\b/i,                         carClass: CANONICAL_CLASSES.PRODUCTION },
  { match: /\bSolstice\b/i,                             carClass: CANONICAL_CLASSES.PRODUCTION },
  { match: /\bOptima\b/i,                               carClass: CANONICAL_CLASSES.PRODUCTION },
];

// ---- explicit overrides for HYMO's raw class names ------------------------
// HYMO's car_class.name is mostly already canonical; this map normalizes the
// few divergences to our canonical strings.
const HYMO_CLASS_OVERRIDES: Record<string, string> = {
  "Single Seaters": CANONICAL_CLASSES.FORMULA,
  "GTP/LMDh":       CANONICAL_CLASSES.GTP_LMDH,
  "GT3":            CANONICAL_CLASSES.GT3,
  "GT4":            CANONICAL_CLASSES.GT4,
  "GTE":            CANONICAL_CLASSES.GTE,
  "GT2":            CANONICAL_CLASSES.GT2,
  "LMP2":           CANONICAL_CLASSES.LMP2,
  "LMP3":           CANONICAL_CLASSES.LMP3,
  "TCR":            CANONICAL_CLASSES.TCR,
  "PCUP":           CANONICAL_CLASSES.PCUP,
  "PCC":            CANONICAL_CLASSES.PCC,
  "NASCAR Cup Series": "NASCAR Cup",
};

/**
 * Normalize a HYMO raw car_class.name to canonical. Unknown values pass
 * through unchanged so we never lose data we just haven't seen yet.
 */
export function canonicalFromHymoClass(rawClass: string): string {
  return HYMO_CLASS_OVERRIDES[rawClass] ?? rawClass;
}

/**
 * Heuristic: derive a canonical class from a car's name alone.
 * Returns null if no rule matched.
 */
export function canonicalFromName(carName: string): string | null {
  for (const rule of NAME_RULES) {
    if (rule.match.test(carName)) return rule.carClass;
  }
  return null;
}

/**
 * The full lookup used by the GnG scraper (and any future scraper that
 * doesn't have a real class field). Order:
 *   1. If a Car row already exists for this name (e.g. inserted earlier by
 *      HYMO), reuse its class -- HYMO's class is canonical.
 *   2. Otherwise, derive from the car's name via NAME_RULES.
 *   3. Otherwise, fall back to the supplied default (typically the GnG
 *      series, last-resort) so we never silently drop a car.
 *
 * Caller passes the prisma client; we do a single indexed lookup on
 * Car.name (now uniquely indexed after the round-3 schema change).
 */
export async function lookupCanonicalClass(
  prisma: Pick<PrismaClient, "car">,
  carName: string,
  fallback: string,
): Promise<string> {
  const existing = await prisma.car.findUnique({
    where: { name: carName },
    select: { carClass: true },
  });
  if (existing) return existing.carClass;

  const fromName = canonicalFromName(carName);
  if (fromName) return fromName;

  return fallback;
}
