// Shared types for /compare and the scraper.

export const SCRAPING_STATUSES = [
  "SCRAPED",
  "AUTH_SCRAPED",
  "LOGIN_WALLED",
  "CLOUDFLARE_BLOCKED",
  "API_LOCKED",
] as const;
export type ScrapingStatus = (typeof SCRAPING_STATUSES)[number];

export const SCRAPING_STATUS_LABELS: Record<ScrapingStatus, string> = {
  SCRAPED: "Scraped",
  AUTH_SCRAPED: "Scraped (authenticated)",
  LOGIN_WALLED: "Login required",
  CLOUDFLARE_BLOCKED: "Cloudflare blocked",
  API_LOCKED: "API locked",
};

export const LAP_TIME_SOURCES = [
  "SHOP_PUBLISHED",
  "DRIVER_SUBMITTED",
  "UNKNOWN",
] as const;
export type LapTimeSource = (typeof LAP_TIME_SOURCES)[number];

// One cell in the comparison table.
export type CompareCell = {
  shopId: number;
  shopName: string;
  scrapingStatus: ScrapingStatus;
  url?: string;
  price?: number | null;
  lapTimeSeconds?: number | null;
  lapTimeSource?: LapTimeSource | null;
};

// One row in the comparison table -- a (car, track) pair.
export type CompareRow = {
  carId: number;
  carName: string;
  carClass: string;
  trackId: number;
  trackName: string;
  cells: CompareCell[]; // one per shop, in stable order
};
