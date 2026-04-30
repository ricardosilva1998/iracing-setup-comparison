/**
 * Canonical track-name lookup.
 *
 * Round 9 fix (mirrors round 3's car-class canonicalisation): HYMO and
 * Grid-and-Go often label the same physical track with slightly different
 * names. The /compare page then renders two adjacent rows for the same
 * (car, track) pair, with each row populated by only one shop. Examples:
 *
 *   HYMO  "Autodromo Internazionale Enzo e Dino Ferrari (Imola)"
 *   GnG   "Autodromo Internazionale Enzo e Dino Ferrari"
 *
 *   HYMO  "Hockenheimring"
 *   GnG   "Hockenheimring Baden-Württemberg"
 *
 *   HYMO  "Summit Point Motorsports Park"
 *   GnG   "Summit Point Raceway"
 *
 * This module produces ONE canonical name per physical track. Strategy
 * (priority order):
 *
 *   1. **Manual override map** for known explicit aliases. Highest priority
 *      because the rules below cannot safely handle a few cases (typos like
 *      "Motorsport" vs "Motorsports", aliases like "Brands Hatch" ->
 *      "Brands Hatch Circuit", spelling variants like "Park Zandvoort").
 *   2. **Strip parenthetical suffixes** (e.g. "(Imola)", "(Mexico City)",
 *      "(Interlagos)") -- these are city tags HYMO appends to disambiguate
 *      that the same physical circuit doesn't need.
 *   3. **Trim + collapse whitespace** -- always last, cleanup pass.
 *
 * Rules we DO NOT apply (deliberately conservative):
 *   - We do NOT strip "Combined" / "Full Course" / "GP" / "Long" / "Short"
 *     suffixes globally. At venues like Nurburgring and Daytona, those
 *     suffixes identify genuinely-different physical layouts (Nurburgring
 *     Combined != Nordschleife != GP-Strecke; Daytona Road Course != Oval).
 *     The manual override map handles the cases where we *do* know the
 *     layout is the same.
 *   - We do NOT strip "Circuit" / "Raceway" / "Park" / "Speedway" suffixes
 *     globally -- "Phillip Island Circuit" is the only name iRacing uses,
 *     so blindly stripping "Circuit" would create new duplicates.
 *
 * The defensive default for unknown raw names is to return the value as-is
 * (after whitespace cleanup). We never silently drop a track.
 *
 * Round 9 conflict list (built from local dev.db SQL prefix scan + token
 * Jaccard >= 0.5):
 *   Adelaide                                        -> Adelaide Street Circuit
 *   Autodromo ...Ferrari (Imola)                    -> Autodromo ...Ferrari
 *   Autódromo Hermanos Rodríguez (Mexico City)      -> Autódromo Hermanos Rodríguez
 *   Autódromo José Carlos Pace (Interlagos)         -> Autódromo José Carlos Pace
 *   Brands Hatch                                    -> Brands Hatch Circuit
 *   Canadian Tire Motorsports Park (typo)           -> Canadian Tire Motorsport Park
 *   Circuit Park Zandvoort                          -> Circuit Zandvoort
 *   Circuito de Jerez - Ángel Nieto                 -> Circuito de Jerez
 *   Donington Park Racing Circuit                   -> Donington Park
 *   Hockenheimring Baden-Württemberg                -> Hockenheimring
 *   Nürburgring's GP-Strecke (HYMO)                 -> Nürburgring Grand-Prix-Strecke
 *   Summit Point Raceway                            -> Summit Point Motorsports Park
 *   WeatherTech Raceway Laguna Seca (no "at")       -> WeatherTech Raceway at Laguna Seca
 */

// ---- canonical names (single source of truth) -----------------------------
// Every alias collapses to one of these. Names not in this set pass through
// unchanged after whitespace cleanup (so newly added tracks don't break).
//
// Round 10 expanded the set substantially because the new shops (gosetups,
// Majors Garage) emit bare-name forms ("Sebring", "Imola", "Spa", "Suzuka")
// where HYMO/GnG use the formal venue names. The canonical of choice is
// always the formal iRacing venue name when one exists, so HYMO + GnG
// rows continue to be authoritative.
export const KNOWN_CANONICAL_TRACK_NAMES = [
  "Adelaide Street Circuit",
  "Algarve International Circuit",
  "Atlanta Motor Speedway",
  "Auto Club Speedway",
  "Autodromo Internazionale Enzo e Dino Ferrari",
  "Autodromo Internazionale del Mugello",
  "Autódromo Hermanos Rodríguez",
  "Autódromo José Carlos Pace",
  "Barber Motorsports Park",
  "Brands Hatch Circuit",
  "Bristol Motor Speedway",
  "Canadian Tire Motorsport Park",
  "Charlotte Motor Speedway",
  "Circuit Zandvoort",
  "Circuit de Spa-Francorchamps",
  "Circuit of the Americas",
  "Circuito de Jerez",
  "Darlington Raceway",
  "Daytona International Speedway",
  "Donington Park",
  "Fuji International Speedway",
  "Hockenheimring",
  "Homestead-Miami Speedway",
  "Indianapolis Motor Speedway",
  "Iowa Speedway",
  "Kansas Speedway",
  "Kentucky Speedway",
  "Las Vegas Motor Speedway",
  "Lime Rock Park",
  "Long Beach Street Circuit",
  "Martinsville Speedway",
  "Michigan International Speedway",
  "Mount Panorama Circuit",
  "Motorsport Arena Oschersleben",
  "Nürburgring Combined",
  "Nürburgring Grand-Prix-Strecke",
  "Nürburgring Nordschleife",
  "Oulton Park Circuit",
  "Phoenix Raceway",
  "Pocono Raceway",
  "Portland International Raceway",
  "Red Bull Ring",
  "Richmond Raceway",
  "Road America",
  "Road Atlanta",
  "Rockingham Speedway",
  "Sachsenring",
  "Sebring International Raceway",
  "Silverstone Circuit",
  "Snetterton Circuit",
  "Sonoma Raceway",
  "St. Petersburg Grand Prix",
  "Summit Point Motorsports Park",
  "Suzuka International Racing Course",
  "Talladega Superspeedway",
  "Texas Motor Speedway",
  "Tsukuba Circuit",
  "Twin Ring Motegi",
  "Virginia International Raceway",
  "Watkins Glen International",
  "WeatherTech Raceway at Laguna Seca",
] as const;

// ---- explicit alias overrides ---------------------------------------------
// Highest-priority pass. The keys are the *raw* names we have seen in scraper
// output; the values are the canonical names above.
//
// Notes:
// - "Adelaide" alone is HYMO's name; GnG uses "Adelaide Street Circuit".
//   We canonicalise to GnG's form because it matches iRacing's official name.
// - "Brands Hatch" alone is HYMO's name; GnG uses "Brands Hatch Circuit".
//   We canonicalise to "Brands Hatch Circuit" (iRacing's name; matches GnG).
// - "Canadian Tire Motorsports Park" (with a trailing 's') is the GnG typo;
//   the official name is "Canadian Tire Motorsport Park" (no 's' on Motorsport).
// - "Circuit Park Zandvoort" is the deprecated old name; the venue is now
//   officially "Circuit Zandvoort".
// - "Donington Park Racing Circuit" is GnG's expansion; HYMO and the venue
//   itself use "Donington Park".
// - "Hockenheimring Baden-Württemberg" is GnG's geographic suffix (the state
//   the venue sits in); the venue is just "Hockenheimring".
// - "Nürburgring's GP-Strecke" (with apostrophe-s) is HYMO's idiosyncratic
//   spelling; GnG uses "Nürburgring Grand-Prix-Strecke" which we keep as
//   the canonical for the GP-only layout. Distinct from "Nürburgring
//   Combined" (full venue) and "Nürburgring Nordschleife" (Nordschleife only).
// - "Summit Point Raceway" is GnG; "Summit Point Motorsports Park" is HYMO
//   and matches the venue's official name. Same physical circuit.
// - "WeatherTech Raceway Laguna Seca" is HYMO (no "at"); the venue's
//   formal name is "WeatherTech Raceway at Laguna Seca".
const TRACK_ALIASES: Record<string, string> = {
  "Adelaide": "Adelaide Street Circuit",
  "Brands Hatch": "Brands Hatch Circuit",
  "Canadian Tire Motorsports Park": "Canadian Tire Motorsport Park",
  "Circuit Park Zandvoort": "Circuit Zandvoort",
  "Donington Park Racing Circuit": "Donington Park",
  "Hockenheimring Baden-Württemberg": "Hockenheimring",
  "Nürburgring’s GP-Strecke": "Nürburgring Grand-Prix-Strecke",
  // Defensive: the same name with the straight ASCII apostrophe.
  "Nürburgring's GP-Strecke": "Nürburgring Grand-Prix-Strecke",
  "Summit Point Raceway": "Summit Point Motorsports Park",
  "WeatherTech Raceway Laguna Seca": "WeatherTech Raceway at Laguna Seca",

  // Round 10 -- gosetups + Majors Garage emit bare-name forms (slug-derived
  // or sheet-header-derived). Each alias canonicalises to the formal
  // iRacing venue name HYMO + GnG already use, so cells consolidate.

  // Sebring family
  "Sebring": "Sebring International Raceway",
  "SEBRING": "Sebring International Raceway",
  "guess what? SEBRING": "Sebring International Raceway",

  // Imola
  "Imola": "Autodromo Internazionale Enzo e Dino Ferrari",
  "Imola GP": "Autodromo Internazionale Enzo e Dino Ferrari",

  // Long Beach
  "Long Beach": "Long Beach Street Circuit",
  "Long Beach Grand Prix": "Long Beach Street Circuit",

  // Mugello
  "Mugello": "Autodromo Internazionale del Mugello",
  "Mugello GP": "Autodromo Internazionale del Mugello",

  // Fuji
  "Fuji": "Fuji International Speedway",
  "Fuji GP": "Fuji International Speedway",

  // Silverstone
  "Silverstone": "Silverstone Circuit",
  "Silverstone GP": "Silverstone Circuit",
  "Silverstone Circuit - Grand Prix": "Silverstone Circuit",

  // Hockenheim
  "Hockenheim": "Hockenheimring",
  "Hockenheim GP": "Hockenheimring",
  "Hockenheimring GP": "Hockenheimring",

  // Spa
  "Spa": "Circuit de Spa-Francorchamps",
  "Spa Francorchamps GP": "Circuit de Spa-Francorchamps",
  "SPA gp pits": "Circuit de Spa-Francorchamps",

  // Laguna Seca
  "Seca": "WeatherTech Raceway at Laguna Seca",
  "Laguna Seca": "WeatherTech Raceway at Laguna Seca",

  // St. Petersburg
  "St. Petersburg": "St. Petersburg Grand Prix",
  "St Petersburg Grand Prix": "St. Petersburg Grand Prix",

  // Algarve
  "Algarve": "Algarve International Circuit",
  "Algarve GP": "Algarve International Circuit",

  // Summit Point
  "Summit Point": "Summit Point Motorsports Park",

  // Oschersleben
  "Oschersleben": "Motorsport Arena Oschersleben",

  // Donington
  "Donington": "Donington Park",
  "Donington GP": "Donington Park",
  "Donington National": "Donington Park",

  // Sonoma
  "Sonoma": "Sonoma Raceway",
  "Sonoma Sportscar ALT": "Sonoma Raceway",

  // VIR
  "Vir": "Virginia International Raceway",
  "VIR": "Virginia International Raceway",
  "Virginia Full": "Virginia International Raceway",
  "Virginia International Raceway Full Course": "Virginia International Raceway",

  // Watkins Glen
  "Watkins Glen": "Watkins Glen International",
  "Watkins Boot": "Watkins Glen International",
  "Watkins Glen International Boot": "Watkins Glen International",
  "Watkins Glen Boot": "Watkins Glen International",

  // Suzuka
  "Suzuka": "Suzuka International Racing Course",
  "Suzuka GP": "Suzuka International Racing Course",

  // Tsukuba
  "Tsukuba": "Tsukuba Circuit",
  "Tsukuba 2000 Full": "Tsukuba Circuit",

  // Charlotte
  "Charlotte": "Charlotte Motor Speedway",

  // Bathurst -> Mount Panorama
  "Bathurst": "Mount Panorama Circuit",

  // Daytona Road Course
  "Daytona Road": "Daytona International Speedway",
  "Daytona": "Daytona International Speedway",

  // Interlagos
  "Interlagos": "Autódromo José Carlos Pace",
  "Interlagos GP": "Autódromo José Carlos Pace",

  // Nürburgring Combined family
  "Nurburgring Combined": "Nürburgring Combined",
  "Nurburgring Combined Gesamtstrecke 24h": "Nürburgring Combined",
  "Nurburgring Combined Gesamstrecke VLN": "Nürburgring Combined",
  "Nords 24h strecke": "Nürburgring Combined",
  "Nurb 24h Strecke": "Nürburgring Combined",
  "Nurb 24h": "Nürburgring Combined",

  // Nordschleife (separate physical layout from Combined)
  "Nordschleife": "Nürburgring Nordschleife",

  // Nürburgring GP family
  "Nurburgring GP": "Nürburgring Grand-Prix-Strecke",
  "Nurburgring Gp": "Nürburgring Grand-Prix-Strecke",
  "Nurburgring GP BES WEC": "Nürburgring Grand-Prix-Strecke",

  // Mexico City
  "Mexico City": "Autódromo Hermanos Rodríguez",
  "Mexico City GP": "Autódromo Hermanos Rodríguez",
  "Mexic GP": "Autódromo Hermanos Rodríguez",

  // Mosport
  "Mosport": "Canadian Tire Motorsport Park",

  // COTA
  "COTA": "Circuit of the Americas",
  "COTA Nascar West": "Circuit of the Americas",

  // Misc bare names
  "Barber": "Barber Motorsports Park",
  "Barber Full": "Barber Motorsports Park",
  "Barber Classic": "Barber Motorsports Park",
  "Lime Rock": "Lime Rock Park",
  "Lime Rock Park Chicanes": "Lime Rock Park",
  "Road Atlanta Full": "Road Atlanta",
  "Road America - Full Course": "Road America",
  "Jerez": "Circuito de Jerez",
  "Jerez Moto": "Circuito de Jerez",
  "Circuito De Navarra": "Circuito de Navarra",
  "Indianapolis": "Indianapolis Motor Speedway",
  "Snetterton": "Snetterton Circuit",
  "Oulton Park": "Oulton Park Circuit",
  "Oulton Intl.": "Oulton Park Circuit",
  "Zandvoort": "Circuit Zandvoort",
  "Zandvoort GP": "Circuit Zandvoort",
  "Twin Ring Motegi": "Twin Ring Motegi",
  "Motegi GP": "Twin Ring Motegi",
  "Mobility Resort Motegi": "Twin Ring Motegi",
  "Motegi Oval": "Twin Ring Motegi",
  "Daytona International Speedway": "Daytona International Speedway",

  // NASCAR / short-oval bare names common in Majors Garage's slug catalogue.
  "Texas": "Texas Motor Speedway",
  "Bristol": "Bristol Motor Speedway",
  "Las Vegas": "Las Vegas Motor Speedway",
  "Auto Club": "Auto Club Speedway",
  "Homestead": "Homestead-Miami Speedway",
  "Iowa": "Iowa Speedway",
  "Michigan": "Michigan International Speedway",
  "Pocono": "Pocono Raceway",
  "Talladega": "Talladega Superspeedway",
  "Darlington": "Darlington Raceway",
  "Kansas": "Kansas Speedway",
  "Richmond": "Richmond Raceway",
  "Atlanta": "Atlanta Motor Speedway",
  "Phoenix": "Phoenix Raceway",
  "Kentucky": "Kentucky Speedway",
  "Martinsville": "Martinsville Speedway",
  "Rockingham": "Rockingham Speedway",
  "Charlotte Motor Speedway": "Charlotte Motor Speedway",
  "Circuit Of The Americas": "Circuit of the Americas",
};

/**
 * Strip a trailing parenthetical suffix from a track name.
 * Examples:
 *   "Autódromo Hermanos Rodríguez (Mexico City)"  -> "Autódromo Hermanos Rodríguez"
 *   "Foo Circuit (some note) (variant)"           -> "Foo Circuit (some note)"
 *
 * Only the last parenthetical group is removed, so chained parens are handled
 * gracefully if they ever appear. We only strip TRAILING parens -- a name
 * like "(SCCA) Some Track" would be left alone.
 */
function stripTrailingParen(name: string): string {
  return name.replace(/\s*\([^()]*\)\s*$/u, "").trim();
}

/**
 * Strip the "- <subname>" suffix used by Spanish circuits.
 * Specifically targets the "Circuito de Jerez - Ángel Nieto" pattern:
 *   "Circuito de Jerez - Ángel Nieto"  -> "Circuito de Jerez"
 *
 * We do NOT do this globally (some track names legitimately contain " - ").
 * Instead, this is invoked only when the bare-prefix form already exists in
 * the alias map, so it acts as a controlled second pass.
 */
function stripDashSuffix(name: string): string {
  const idx = name.lastIndexOf(" - ");
  if (idx <= 0) return name;
  return name.slice(0, idx).trim();
}

/**
 * Collapse all whitespace runs to a single space and trim.
 * Defensive cleanup -- always last.
 */
function normaliseWhitespace(name: string): string {
  return name.replace(/\s+/gu, " ").trim();
}

/**
 * Public entry point. Pure function; no DB calls.
 *
 * Returns the canonical name for the given raw track name. If no rule
 * matches, returns the input (after whitespace cleanup) so we never
 * silently drop a track.
 */
export function canonicalizeTrackName(rawName: string): string {
  if (!rawName) return rawName;

  // 0. Whitespace cleanup pass first so the alias map's keys can be exact
  //    matches without worrying about random double-spaces.
  let name = normaliseWhitespace(rawName);

  // 1. Manual alias override (highest priority).
  if (name in TRACK_ALIASES) {
    return TRACK_ALIASES[name];
  }

  // 2. Strip trailing parenthetical (handles "(Imola)", "(Mexico City)",
  //    "(Interlagos)" and any future similar parenthetical city tag).
  const withoutParen = stripTrailingParen(name);
  if (withoutParen !== name) {
    // After stripping parens, re-check the alias map in case the un-parened
    // form is itself an alias (e.g. nothing today, but defensive).
    if (withoutParen in TRACK_ALIASES) {
      return TRACK_ALIASES[withoutParen];
    }
    name = withoutParen;
  }

  // 3. Strip " - <subname>" suffix only when the bare form is a known
  //    canonical (or alias key). This catches "Circuito de Jerez - Ángel
  //    Nieto" -> "Circuito de Jerez" without breaking unrelated tracks
  //    that legitimately contain " - " elsewhere in their name.
  const withoutDash = stripDashSuffix(name);
  if (
    withoutDash !== name &&
    (
      (KNOWN_CANONICAL_TRACK_NAMES as readonly string[]).includes(withoutDash) ||
      withoutDash in TRACK_ALIASES
    )
  ) {
    if (withoutDash in TRACK_ALIASES) {
      return TRACK_ALIASES[withoutDash];
    }
    name = withoutDash;
  }

  return name;
}
