/**
 * Maps each canonical car name (from lib/car-name-canonical.ts KNOWN_CANONICAL_CAR_NAMES)
 * to the iRacing setup folder name in ~/Documents/iRacing/setups/<folder>/.
 *
 * iRacing folder names are arbitrary internal IDs that don't follow a slugify-able rule.
 * User provided the list from screenshots on 2026-04-30. Update this map if iRacing
 * adds/renames folders.
 *
 * For a canonical car name not in this map, the bridge app falls back to letting
 * the user manually type the target folder.
 *
 * Deliberately omitted cases (fall back to manual):
 *   "Ford GT GTE"  — iRacing has both `fordgt` and `fordgt gt3` folders; the GTE
 *     variant is ambiguous. The GT2 variant ("fordgt2017") is confirmed.
 *   "Lexus RC F GT3"  — not visible in user's screenshots; user may not own the car.
 *   "KTM X-BOW GT2"  — not visible in user's screenshots.
 *   "Ginetta G55 GT4"  — not visible in user's screenshots.
 *   "FIA F4"  — not visible in user's screenshots.
 *   "Ray FF1600"  — not visible in user's screenshots.
 *   "Skip Barber Formula 2000"  — not visible in user's screenshots.
 *   "O'Reilly chassis"  — not visible in user's screenshots.
 *   "NASCAR Cup Series Next Gen Chevrolet Camaro ZL1"  — user has multiple Chevy
 *     folders (stockcars2 chevy, gen4cup, etc.); ambiguous which is the Cup Next Gen.
 *   "NASCAR Truck Chevrolet Silverado"  — `trucks silverado` is a candidate but
 *     cannot be confirmed from screenshots alone.
 */
export const IRACING_CAR_FOLDERS: Record<string, string> = {
  // GT3
  "Acura NSX GT3 EVO 22":                    "acuransxevo22gt3",
  "Aston Martin Vantage GT3 EVO":            "amvantageevogt3",
  "Audi R8 LMS EVO II GT3":                  "audir8lmsevo2gt3",
  "BMW M4 GT3 EVO":                          "bmwm4gt3",
  "Chevrolet Corvette Z06 GT3.R":            "chevyvettez06gt3",
  "Ferrari 296 GT3":                         "ferrari296gt3",
  "Ford Mustang GT3":                        "fordmustanggt3",
  "Lamborghini Huracán GT3 EVO":             "lamborghinievogt3",
  "McLaren 720S GT3 EVO":                    "mclaren720sgt3",
  "Mercedes-AMG GT3 2020":                   "mercedesamgevogt3",
  "Porsche 911 GT3 R (992)":                 "porsche992rgt3",

  // GTE
  "BMW M8 GTE":                              "bmwm8gte",
  "Chevrolet Corvette C8.R GTE":             "c8rvettegte",
  "Ferrari 488 GTE":                         "ferrari488gte",
  "Porsche 911 RSR":                         "porsche991rsr",
  // "Ford GT GTE" — omitted; ambiguous between `fordgt` and `fordgt gt3` folders.

  // GT2
  "Ford GT GT2":                             "fordgt2017",

  // GT4
  "Aston Martin Vantage GT4":                "amvantagegt4",
  "BMW M4 G82 GT4":                          "bmwm4gt4",
  "McLaren 570S GT4":                        "mclaren570sgt4",
  "Mercedes-AMG GT4":                        "mercedesamggt4",
  "Porsche 718 Cayman GT4 Clubsport MR":     "porsche718gt4",
  "Toyota GR86":                             "toyotagr86",

  // GTP / LMDh
  "Acura ARX-06 GTP":                        "acuraarx06gtp",
  "BMW M Hybrid V8":                         "bmwlmdh",
  "Cadillac V-Series.R GTP":                 "cadillacvseriesrgtp",
  "Ferrari 499P":                            "ferrari499p",
  "Porsche 963 GTP":                         "porsche963gtp",

  // LMP2
  "Dallara P217":                            "dallarap217",

  // LMP3
  "Ligier JS P320":                          "ligierjsp320",

  // TCR
  "Audi RS 3 LMS GEN 2 TCR":                "audirs3lmsgen2",
  "Honda Civic Type R TCR":                  "hondacivictyper",
  "Hyundai Elantra N TCR":                   "hyundaielantracn7",

  // PCUP
  "Porsche 911 Cup (992.2)":                 "porsche9922cup",

  // PCC
  // iRacing's folder name has a space: "mx5 mx52016"
  "Global Mazda MX-5 Cup":                   "mx5 mx52016",

  // Formula
  "Dallara F3":                              "dallaraf3",
  "Dallara IL-15":                           "dallarail15",
  "Dallara IR18":                            "dallarair18",
  "Super Formula Lights":                    "superformulalights324",

  // Production
  "BMW M2 CS Racing":                        "bmwm2csr",
};

/**
 * Lookup helper. Returns the iRacing folder name for a canonical car name,
 * or null if no mapping exists (caller should fall back to manual input).
 */
export function lookupIracingFolder(canonicalName: string): string | null {
  return IRACING_CAR_FOLDERS[canonicalName] ?? null;
}
