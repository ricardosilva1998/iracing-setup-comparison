/**
 * Canonical car-name lookup.
 *
 * Round 13 fix: multiple setup shops spell the same physical iRacing car
 * differently. Examples:
 *
 *   HYMO  "Aston Martin Vantage GT3 EVO"
 *   GnG   "Aston Martin GT3"
 *   MG    "Aston Martin Vantage GT3 EVO"
 *
 *   HYMO  "Cadillac V-Series.R GTP"
 *   MG    "Cadillac V-Series R GTP"   (missing the dot)
 *
 *   MG    "Mclaren 720s EVO"
 *   HYMO  "McLaren 720S GT3 EVO"
 *
 * This fragments the same physical car into multiple Car rows. The /compare
 * page then renders multiple rows per car, each populated by a different
 * subset of shops. This module produces ONE canonical name per physical car.
 *
 * Strategy (priority order, mirrors lib/track-canonical.ts exactly):
 *
 *   1. Trim whitespace + collapse double-spaces.
 *   2. Exact lookup in CAR_NAME_ALIASES (case-sensitive on the trimmed input).
 *      If hit -> return the canonical name.
 *   3. Slug-leak suffix-strip pass. If the input ends with one of
 *      MG_SLUG_LEAK_SUFFIXES, strip the suffix. Accept only if the stripped
 *      form is in KNOWN_CANONICAL_CAR_NAMES; otherwise pass through unchanged.
 *      This is the round-9 conservative pattern.
 *   4. Defensive default: return the (cleaned) input unchanged.
 *
 * The defensive default for unknown raw names is to return the value as-is
 * (after whitespace cleanup). We never silently drop a car.
 *
 * DO NOT MERGE these genuinely-different iRacing models:
 *   - Ford GT GT2 vs Ford GT GTE  (distinct iRacing models)
 *   - BMW M4 G82 GT4 vs BMW M4 GT4  (bare "BMW M4 GT4" kept separate)
 *   - Super Formula SF23 - Honda vs - Toyota vs bare SF23 (distinct variants)
 *   - Ferrari 296 GT3 vs Ferrari 296 Challenge (different models)
 *   - All Dirt Big Block / Dirt Late Model / Dirt Sprint Car / Dirt Ump
 *     Modified / Dirt Micro Sprint / Sk Modified / Tour Mod / Late Model /
 *     Legend / Spec Racer Ford / Lotus 79 rows from MG whose slug-derived
 *     names have track-name leakage -- handled via MG_SLUG_LEAK_SUFFIXES,
 *     NOT individual aliases.
 */

// ---- canonical car names (single source of truth) -------------------------
// Every alias collapses to one of these. Names not in this set pass through
// unchanged after whitespace cleanup (so newly added cars don't break).
// These must match the HYMO authoritative names exactly (HYMO is the
// reference scraper per the round-3 car-class invariant).
export const KNOWN_CANONICAL_CAR_NAMES = new Set([
  // GT3
  "Acura NSX GT3 EVO 22",
  "Aston Martin Vantage GT3 EVO",
  "Audi R8 LMS EVO II GT3",
  "BMW M4 GT3 EVO",
  "Chevrolet Corvette Z06 GT3.R",
  "Ferrari 296 GT3",
  "Ford Mustang GT3",
  "Lamborghini Huracán GT3 EVO",
  "Lexus RC F GT3",
  "McLaren 720S GT3 EVO",
  "Mercedes-AMG GT3 2020",
  "Porsche 911 GT3 R (992)",

  // GTE
  "BMW M8 GTE",
  "Chevrolet Corvette C8.R GTE",
  "Ferrari 488 GTE",
  "Ford GT GTE",
  "Porsche 911 RSR",

  // GT2
  "Ford GT GT2",
  "KTM X-BOW GT2",

  // GT4
  "Aston Martin Vantage GT4",
  "BMW M4 G82 GT4",
  "Ginetta G55 GT4",
  "McLaren 570S GT4",
  "Mercedes-AMG GT4",
  "Porsche 718 Cayman GT4 Clubsport MR",
  "Toyota GR86",

  // GTP / LMDh
  "Acura ARX-06 GTP",
  "BMW M Hybrid V8",
  "Cadillac V-Series.R GTP",
  "Ferrari 499P",
  "Porsche 963 GTP",

  // LMP2
  "Dallara P217",

  // LMP3
  "Ligier JS P320",

  // TCR
  "Audi RS 3 LMS GEN 2 TCR",
  "Honda Civic Type R TCR",
  "Hyundai Elantra N TCR",

  // PCUP
  "Porsche 911 Cup (992.2)",

  // PCC
  "Global Mazda MX-5 Cup",

  // Formula
  "Dallara F3",
  "Dallara IL-15",
  "Dallara IR18",
  "FIA F4",
  "Ray FF1600",
  "Skip Barber Formula 2000",
  "Super Formula Lights",

  // Production
  "BMW M2 CS Racing",

  // NASCAR / Oval
  "NASCAR Cup Series Next Gen Chevrolet Camaro ZL1",
  "NASCAR Truck Chevrolet Silverado",

  // Cars added by round 10 (MG / GO Setups)
  "O'Reilly chassis",
]);

// Pre-built lowercase lookup for the case-insensitive step (Step 2).
// Maps lowercased canonical name -> exact canonical name.
const CANONICAL_LOWER_MAP = new Map<string, string>(
  [...KNOWN_CANONICAL_CAR_NAMES].map((name) => [name.toLowerCase(), name]),
);

// ---- explicit alias overrides ---------------------------------------------
// Highest-priority pass. Keys are the *raw* names scrapers emit; values are
// the canonical names.
//
// Notes per alias group:
//
// Bucket A -- cross-shop spelling differences:
//   "Aston Martin GT3" / "Aston Martin GT3 Evo": HYMO name is
//     "Aston Martin Vantage GT3 EVO" (full chassis name). GnG and gosetups
//     emit the shorter form.
//   "Audi R8 LMS GT3 EVO II" / "Audi R8 LMS evo II GT3": HYMO uses
//     "Audi R8 LMS EVO II GT3". Gosetups/MG use inverted or mixed-case.
//   "Audi RS 3 LMS TCR gen2": HYMO uses "Audi RS 3 LMS GEN 2 TCR".
//   "BMW M Hybrid V8 GTP" / "BMW LMDh": GnG and MG emit these; HYMO has
//     "BMW M Hybrid V8" (no GTP suffix).
//   "Cadillac V-Series R GTP" (dot missing): MG slug-derived.
//   "Dallara P217 (LMP2)": gosetups appends class in parentheses.
//   "Dallara Il 15": MG slug capitalisation ("Il" vs "IL").
//   "Ferrari 499P GTP": GnG appends "GTP"; HYMO drops it.
//   "FIA F4 Open Wheel": P1Doks appends " Open Wheel"; double-space collapses
//     before alias lookup so "FIA F4  Open Wheel" -> "FIA F4 Open Wheel".
//   "Ligier JS P320 LMP3": gosetups appends class.
//   "Mclaren 720s EVO": MG slug-derived lower-s, no "GT3".
//   "Mercedes GT4": bare name; HYMO has "Mercedes-AMG GT4" with hyphen.
//   "O'reilly chassis": wrong apostrophe case from MG.
//   "Porsche 991 RSR" / "Porsche 911 RSR GTE": HYMO has "Porsche 911 RSR".
//   "Porsche 963": bare name without "GTP"; HYMO has "Porsche 963 GTP".
//   "Super Formula Lights Open Wheel": P1Doks appends "Open Wheel".
//   "IR18 IndyCar Open Wheel": P1Doks; HYMO name is "Dallara IR18".
//
// Bucket C -- user-confirmed ambiguous merges:
//   "BMW M2" / "BMW M2 CS" / "BMW M2 CSR": all map to "BMW M2 CS Racing".
//   "BMW M4 GT3": bare name without "EVO" -> "BMW M4 GT3 EVO".
//   "Chevrolet Corvette C8.R" (no "GTE"): MG; HYMO has "Chevrolet Corvette C8.R GTE".
export const CAR_NAME_ALIASES: Record<string, string> = {
  // ---- Bucket A: cross-shop spelling differences -----

  // Aston Martin
  "Aston Martin GT3":                    "Aston Martin Vantage GT3 EVO",
  "Aston Martin GT3 Evo":               "Aston Martin Vantage GT3 EVO",

  // Audi R8
  "Audi R8 LMS GT3 EVO II":             "Audi R8 LMS EVO II GT3",
  // Trailing-space variant emitted by gosetups SHEET_TO_HYMO_CAR_ALIASES:
  // whitespace is normalised before lookup so "Audi R8 LMS evo II GT3 "
  // becomes "Audi R8 LMS evo II GT3" and hits the entry below.
  "Audi R8 LMS evo II GT3":             "Audi R8 LMS EVO II GT3",

  // Audi RS3
  "Audi RS 3 LMS TCR gen2":             "Audi RS 3 LMS GEN 2 TCR",
  "Audi RS3 LMS Gen2 TCR":              "Audi RS 3 LMS GEN 2 TCR",
  "Audi RS3 LMS Gen2":                  "Audi RS 3 LMS GEN 2 TCR",

  // BMW M Hybrid
  "BMW M Hybrid V8 GTP":                "BMW M Hybrid V8",
  "BMW LMDh":                           "BMW M Hybrid V8",
  "BMW M-Hybrid LMDh":                  "BMW M Hybrid V8",
  "BMW M Hybrid LMDh":                  "BMW M Hybrid V8",
  "BMW M Hybrid":                       "BMW M Hybrid V8",

  // Cadillac
  "Cadillac V-Series R GTP":            "Cadillac V-Series.R GTP",
  "Cadillac GTP":                       "Cadillac V-Series.R GTP",

  // Dallara P217
  "Dallara P217 (LMP2)":                "Dallara P217",
  "Dallara P217 LMP2":                  "Dallara P217",

  // Dallara IL-15
  "Dallara Il 15":                      "Dallara IL-15",

  // Ferrari 499P
  "Ferrari 499P GTP":                   "Ferrari 499P",

  // FIA F4 (double-space collapses to single before alias lookup)
  "FIA F4 Open Wheel":                  "FIA F4",

  // Lamborghini (no umlaut)
  "Lamborghini Huracan GT3 EVO":        "Lamborghini Huracán GT3 EVO",

  // Ligier JS P320
  "Ligier JS P320 LMP3":                "Ligier JS P320",

  // McLaren 720S
  "Mclaren 720s EVO":                   "McLaren 720S GT3 EVO",
  "Mclaren 720s":                       "McLaren 720S GT3 EVO",

  // Mercedes
  "Mercedes GT4":                       "Mercedes-AMG GT4",
  "Mercedes AMG GT4":                   "Mercedes-AMG GT4",
  "Mercedes AMG GT3":                   "Mercedes-AMG GT3 2020",

  // O'Reilly chassis
  "O'reilly chassis":                   "O'Reilly chassis",

  // Porsche 911 RSR
  "Porsche 991 RSR":                    "Porsche 911 RSR",
  "Porsche 911 RSR GTE":                "Porsche 911 RSR",

  // Porsche 911 GT3 R
  "Porsche 911 GT3 R":                  "Porsche 911 GT3 R (992)",
  "Porsche 992 GT3 R":                  "Porsche 911 GT3 R (992)",

  // Porsche 963
  "Porsche 963":                        "Porsche 963 GTP",
  "Porsche 963 GTP":                    "Porsche 963 GTP",

  // Super Formula Lights
  "Super Formula Lights Open Wheel":    "Super Formula Lights",

  // Dallara IR18
  "IR18 IndyCar Open Wheel":            "Dallara IR18",

  // ---- Bucket C: user-confirmed ambiguous merges -----

  // BMW M2 family
  "BMW M2":                             "BMW M2 CS Racing",
  "BMW M2 CS":                          "BMW M2 CS Racing",
  "BMW M2 CSR":                         "BMW M2 CS Racing",

  // BMW M4 GT3
  "BMW M4 GT3":                         "BMW M4 GT3 EVO",

  // Chevrolet Corvette C8.R
  "Chevrolet Corvette C8.R":            "Chevrolet Corvette C8.R GTE",

  // ---- Bucket D: GO Setups structural differences -----
  // GO Setups names that differ in structure (not just casing) from HYMO.

  // Acura ARX-06 (hyphen missing)
  "Acura ARX 06 GTP":                   "Acura ARX-06 GTP",
  "Acura ARX06 GTP":                    "Acura ARX-06 GTP",

  // Cadillac V-Series (dot and space differences)
  "Cadillac V Series.R GTP":            "Cadillac V-Series.R GTP",
  "Cadillac V Series R GTP":            "Cadillac V-Series.R GTP",

  // Corvette (no Chevrolet prefix, no dot in C8.R)
  "Corvette C8R GTE":                   "Chevrolet Corvette C8.R GTE",
  "Corvette C8.R GTE":                  "Chevrolet Corvette C8.R GTE",
  "Corvette Z06 GT3":                   "Chevrolet Corvette Z06 GT3.R",
  "Corvette Z06 GT3.R":                 "Chevrolet Corvette Z06 GT3.R",

  // Dallara ir-18 (lowercase + hyphen variant from GO Setups)
  "Dallara ir-18":                      "Dallara IR18",
  "Dallara ir18":                       "Dallara IR18",

  // Dallara IL15 (no hyphen, P1Doks)
  "Dallara IL15":                       "Dallara IL-15",

  // Ferrari 499 (no P suffix, MG)
  "Ferrari 499":                        "Ferrari 499P",

  // Ford GT GTE (GO Setups uses "Ford GT GTE", GnG uses "Ford GTE" — both map to "Ford GT GTE")
  "Ford GTE":                           "Ford GT GTE",
  // Ford Mustang GT3/GT4 title-case (MG)
  "Ford Gt3":                           "Ford Mustang GT3",

  // Formula 3 (GO Setups) -> Dallara F3
  "Formula 3":                          "Dallara F3",

  // Mazda MX-5 (GO Setups + MG)
  "Mazda MX5 Cup":                      "Global Mazda MX-5 Cup",
  "Mazda MX-5 Cup":                     "Global Mazda MX-5 Cup",
  "Mazda Mx5":                          "Global Mazda MX-5 Cup",
  "Mazda MX5":                          "Global Mazda MX-5 Cup",

  // Mercedes AMG GT3 2020 (GO Setups adds year but no hyphen after AMG)
  "Mercedes AMG GT3 2020":              "Mercedes-AMG GT3 2020",

  // Porsche 911 GT3 R 992 (MG slug removes parentheses)
  "Porsche 911 GT3 R 992":              "Porsche 911 GT3 R (992)",
  "Porsche 911 GT3 R (992.2)":          "Porsche 911 GT3 R (992)",

  // Porsche Cup 9922 (MG: slug collapses "Cup 992.2" -> "Cup 9922")
  "Porsche Cup 9922":                   "Porsche 911 Cup (992.2)",

  // Porsche RSR (MG: short form)
  "Porsche RSR":                        "Porsche 911 RSR",
  "Porsche Rsr":                        "Porsche 911 RSR",

  // Porsche 718 Cayman GT4 (MG: shorter form without full name)
  "Porsche 718 GT4":                    "Porsche 718 Cayman GT4 Clubsport MR",
  "Porsche 718 Gt4":                    "Porsche 718 Cayman GT4 Clubsport MR",
  "Porsche 718 Cayman GT4":             "Porsche 718 Cayman GT4 Clubsport MR",

  // Acura NSX GT3 (MG: no EVO 22 suffix)
  "Acura NSX GT3":                      "Acura NSX GT3 EVO 22",
  "Acura Nsx Gt3":                      "Acura NSX GT3 EVO 22",

  // Acura ARX GTP (MG title-case slug)
  "Acura Arx Gtp":                      "Acura ARX-06 GTP",

  // Audi R8 LMS GT3 (MG: no EVO II suffix)
  "Audi R8 Lms Gt3":                    "Audi R8 LMS EVO II GT3",
  "Audi R8 LMS GT3":                    "Audi R8 LMS EVO II GT3",

  // Audi RS3 LMS Gen2 (MG title-case)
  "Audi Rs3 Lms Gen2":                  "Audi RS 3 LMS GEN 2 TCR",

  // BMW LMDh (MG title-case)
  "Bmw Lmdh":                           "BMW M Hybrid V8",

  // BMW M2 (MG title-case)
  "Bmw M2":                             "BMW M2 CS Racing",

  // BMW M4 G82 GT4 (MG title-case)
  "Bmw M4 G82 Gt4":                     "BMW M4 G82 GT4",

  // BMW M4 GT3 EVO (MG title-case)
  "Bmw M4 Gt3 Evo":                     "BMW M4 GT3 EVO",

  // BMW M8 GTE (MG title-case)
  "Bmw M8 Gte":                         "BMW M8 GTE",

  // Cadillac GTP (MG: bare short form)
  "Cadillac Gtp":                       "Cadillac V-Series.R GTP",

  // Corvette C8r Gte (MG title-case)
  "Corvette C8r Gte":                   "Chevrolet Corvette C8.R GTE",

  // Corvette Z06 Gt3 (MG title-case)
  "Corvette Z06 Gt3":                   "Chevrolet Corvette Z06 GT3.R",

  // Dallara Ir18 (MG title-case)
  "Dallara Ir18":                       "Dallara IR18",

  // Dallara P217 Lmp2 (MG title-case + class suffix)
  "Dallara P217 Lmp2":                  "Dallara P217",

  // Ferrari 296 Gt3 (MG title-case)
  "Ferrari 296 Gt3":                    "Ferrari 296 GT3",

  // Ferrari 488 Gte (MG title-case)
  "Ferrari 488 Gte":                    "Ferrari 488 GTE",

  // Ford Mustang Gt3 / Gt4 (MG title-case)
  "Ford Mustang Gt3":                   "Ford Mustang GT3",
  "Ford Mustang Gt4":                   "Ford Mustang GT4",

  // Ford Gte (MG title-case)
  "Ford Gte":                           "Ford GT GTE",

  // Honda Civic TCR (MG: no "Type R" in the name)
  "Honda Civic Tcr":                    "Honda Civic Type R TCR",
  "Honda Civic TCR":                    "Honda Civic Type R TCR",

  // Hyundai Elantra (MG: no "N TCR" suffix)
  "Hyundai Elantra":                    "Hyundai Elantra N TCR",

  // Lamborghini GT3 (MG: no Huracán in name)
  "Lamborghini Gt3":                    "Lamborghini Huracán GT3 EVO",
  "Lamborghini GT3":                    "Lamborghini Huracán GT3 EVO",

  // Ligier Js P320 (MG title-case)
  "Ligier Js P320":                     "Ligier JS P320",

  // McLaren 570 GT4 (MG: space instead of S)
  "Mclaren 570 Gt4":                    "McLaren 570S GT4",
  "McLaren 570 GT4":                    "McLaren 570S GT4",

  // McLaren 720S EVO (MG title-case + no GT3)
  "Mclaren 720s Evo":                   "McLaren 720S GT3 EVO",

  // Mercedes AMG GT3 / GT4 (MG title-case, no hyphen)
  "Mercedes Amg Gt3":                   "Mercedes-AMG GT3 2020",
  "Mercedes Amg Gt4":                   "Mercedes-AMG GT4",

  // Porsche 963 Gtp (MG title-case)
  "Porsche 963 Gtp":                    "Porsche 963 GTP",

  // Porsche 911 Gt3 R 992 (MG title-case, no parentheses)
  "Porsche 911 Gt3 R 992":              "Porsche 911 GT3 R (992)",

  // Porsche Cup 9922 (MG title-case alias already covered above)

  // SF23 (P1Doks bare name; HYMO doesn't sell SF23 setups — keep as-is; this is a single-shop car)
  // Note: SF23 maps to nothing in HYMO, so we leave it as "SF23" (defensive pass-through).

  // Skip Barber (MG bare name — same as "Skip Barber Formula 2000" per user)
  "Skip Barber":                        "Skip Barber Formula 2000",

  // Super Formula Light (MG: missing plural "s")
  "Super Formula Light":                "Super Formula Lights",

  // Toyota Gr86 (MG title-case)
  "Toyota Gr86":                        "Toyota GR86",
};

// ---- slug-leak suffixes (Bucket B) ----------------------------------------
// Applied AFTER the alias map miss. Strip the suffix; accept only if the
// stripped form is in KNOWN_CANONICAL_CAR_NAMES.
//
// These are suffixes that Majors Garage's slug-parser appends to a car name
// because the slug-parser cannot cleanly separate the car part from the track
// part of a combined slug (e.g. "ferrari-296-gt3-miami" where "miami" is the
// track suffix that bleeds into the car name when the track isn't in
// KNOWN_TRACK_SLUGS).
//
// Sorted longest-first in the exported array so callers strip the most
// specific suffix first.
export const MG_SLUG_LEAK_SUFFIXES = [
  " Autódromo Hermanos",
  " Autodromo Hermanos",
  " Canadian Tire Motorsports",
  " The Dirt Track At",
  " Lucas Oil",
  " Nashville",
  " Motorland",
  " Nurburgring",
  " Nürburgring",
  " Lincoln",
  " Williams",
  " Thruxton",
  " Oswego",
  " Philip",
  " Phillip",
  " Laguna",
  " Myrtle",
  " Cedar",
  " Miami",
  " Kern",
  " Chili",
  " Open Wheel",
  // Short suffix "La" (Tour Mod La -> Tour Mod) — kept last and most conservative
  // because it could false-positive. Only applies if the stripped form is in
  // KNOWN_CANONICAL_CAR_NAMES, which "Tour Mod" is not, so it's a no-op in practice.
  " La",
] as const;

// Longest-first for greedy matching.
const SLUG_SUFFIXES_SORTED = [...MG_SLUG_LEAK_SUFFIXES].sort(
  (a, b) => b.length - a.length,
);

// ---- helpers ---------------------------------------------------------------

function normaliseWhitespace(name: string): string {
  return name.replace(/\s+/gu, " ").trim();
}

// ---- public entry point ----------------------------------------------------

/**
 * Return the canonical name for the given raw car name. If no rule matches,
 * returns the input (after whitespace cleanup) so we never silently drop a car.
 *
 * Pure function; no DB calls.
 *
 * Priority order:
 *   1. Whitespace normalisation.
 *   2. Exact alias lookup in CAR_NAME_ALIASES (case-sensitive, highest priority).
 *   3. Case-insensitive lookup against KNOWN_CANONICAL_CAR_NAMES — handles
 *      title-case variants emitted by Majors Garage's slug-parser (e.g.
 *      "Aston Martin Vantage Gt3 Evo" -> "Aston Martin Vantage GT3 EVO").
 *   4. Slug-leak suffix strip + case-insensitive canonical check — handles MG
 *      names like "Aston Martin Vantage Gt3 Evo Laguna" (strip " Laguna", then
 *      look up case-insensitively).
 *   5. Defensive default: return the cleaned input unchanged.
 */
export function canonicalizeCarName(rawName: string): string {
  if (!rawName) return rawName;

  // Step 1: whitespace normalisation so alias keys can be exact matches
  // without worrying about double-spaces from P1Doks / gosetups.
  const name = normaliseWhitespace(rawName);

  // Step 2: exact alias lookup (highest priority).
  if (name in CAR_NAME_ALIASES) {
    return CAR_NAME_ALIASES[name];
  }

  // Step 3: case-insensitive lookup against known canonical names. Handles
  // Majors Garage title-case slug variants ("Bmw M4 Gt3 Evo" -> "BMW M4 GT3 EVO").
  const canonical = CANONICAL_LOWER_MAP.get(name.toLowerCase());
  if (canonical) {
    return canonical;
  }

  // Step 4: slug-leak suffix strip (conservative). Try each suffix longest
  // first; accept the stripped form only if it matches (case-insensitively) a
  // known canonical name.
  for (const suffix of SLUG_SUFFIXES_SORTED) {
    if (name.endsWith(suffix)) {
      const stripped = name.slice(0, name.length - suffix.length).trimEnd();
      if (stripped.length > 0) {
        // Direct canonical check
        if (KNOWN_CANONICAL_CAR_NAMES.has(stripped)) {
          return stripped;
        }
        // Case-insensitive canonical check (for title-case + slug-leak combos)
        const strippedCanonical = CANONICAL_LOWER_MAP.get(stripped.toLowerCase());
        if (strippedCanonical) {
          return strippedCanonical;
        }
        // Alias check on the stripped form (e.g. "Corvette Z06 Gt3 Laguna" ->
        // strip Laguna -> "Corvette Z06 Gt3" -> alias -> "Chevrolet Corvette Z06 GT3.R")
        if (stripped in CAR_NAME_ALIASES) {
          return CAR_NAME_ALIASES[stripped];
        }
      }
    }
  }

  // Defensive default: return the cleaned input.
  return name;
}
