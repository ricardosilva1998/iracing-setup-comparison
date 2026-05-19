// Shared TypeScript interfaces mirroring Rust serde shapes and API responses.

export interface Settings {
  serverUrl: string;
  iracingRoot: string;
  hasCredentials: boolean;
}

export interface Week {
  weekNum: number;
  label: string;
  setupCount: number;
}

export interface Track {
  id: number;
  name: string;
  setupCount: number;
}

export interface Car {
  id: number;
  name: string;
  carClass: string;
  iracingFolderName: string | null;
}

export interface ShopFiles {
  shopName: string;
  shopSlug: string;
  datapackId: string | null;
  externalId: string | null;
  fileNames: string[];
  cached: boolean;
}

export type Screen = "picker" | "bulk" | "manage" | "settings";

export type BulkLogStatus = "ok" | "skipped" | "error";

export interface BulkLogEntry {
  car: string;
  track: string;
  status: BulkLogStatus;
  message: string;
  folder?: string;
}

export interface BulkProgress {
  current: number;
  total: number;
  carName: string;
  trackName: string;
  status: "downloading" | "skipped" | "ok" | "error";
  message?: string;
}

// --- Round 36 additions (multi-season picker) ---

export interface Season {
  year: number;
  quarter: number;
  label: string;
  setupCount: number;
}

export interface CarShopRef {
  shopSlug: string;
  shopName: string;
  datapackId: string | null;
  externalId: string | null;
  listingUrl: string;
}

export interface CarInClass {
  id: number;
  name: string;
  iracingFolderName: string | null;
  shops: CarShopRef[];
}

export interface ClassGroup {
  carClass: string;
  cars: CarInClass[];
}

export interface TrackByClass {
  trackName: string;
  classes: ClassGroup[];
}

export type PickerView =
  | { kind: "weeks" }
  | { kind: "tracks"; weekNum: number }
  | { kind: "track-detail"; weekNum: number; trackId: number };
