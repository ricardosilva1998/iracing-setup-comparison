import { invoke } from "@tauri-apps/api/core";
import type { CarInClass, CarShopRef } from "../../types";
import { slugify, defaultFolderForCar } from "../../helpers";

export function seasonLabel(year: number, quarter: number): string {
  return `${String(year).slice(-2)}s${quarter}`;
}

export type ShopChipState = {
  enabled: boolean;
  reason: "no-cars" | "no-pipeline" | "hymo-historical" | null;
  carsWithFiles: CarInClass[];
};

const FILE_PIPELINE_SHOPS = new Set(["grid-and-go", "hymo"]);

export function evaluateShopChip(
  shopSlug: string,
  cars: CarInClass[],
  isCurrentSeason: boolean,
): ShopChipState {
  if (!FILE_PIPELINE_SHOPS.has(shopSlug)) {
    return { enabled: false, reason: "no-pipeline", carsWithFiles: [] };
  }
  if (shopSlug === "hymo" && !isCurrentSeason) {
    return { enabled: false, reason: "hymo-historical", carsWithFiles: [] };
  }
  const carsWithFiles = cars.filter((car) =>
    car.shops.some(
      (s) =>
        s.shopSlug === shopSlug &&
        ((shopSlug === "grid-and-go" && s.datapackId) ||
          (shopSlug === "hymo" && s.externalId)),
    ),
  );
  if (carsWithFiles.length === 0) {
    return { enabled: false, reason: "no-cars", carsWithFiles: [] };
  }
  return { enabled: true, reason: null, carsWithFiles };
}

export function buildDownloadArgs(opts: {
  car: CarInClass;
  shopSlug: string;
  trackName: string;
  iracingFolder: string;
  serverUrl: string;
  year: number;
  quarter: number;
}): Record<string, unknown> | null {
  const shopRef: CarShopRef | undefined = opts.car.shops.find((s) => s.shopSlug === opts.shopSlug);
  if (!shopRef) return null;

  let assetUrl: string | null = null;
  let resolvedDatapackId = "";

  if (opts.shopSlug === "grid-and-go" && shopRef.datapackId) {
    resolvedDatapackId = shopRef.datapackId;
    assetUrl = null;
  } else if (opts.shopSlug === "hymo" && shopRef.externalId) {
    assetUrl = `${opts.serverUrl}/api/files/hymo/${shopRef.externalId}/zip`;
  } else {
    return null;
  }

  return {
    carSlug: slugify(opts.car.name),
    seasonLabel: seasonLabel(opts.year, opts.quarter),
    trackSlug: slugify(opts.trackName),
    shopSlug: opts.shopSlug,
    datapackId: resolvedDatapackId,
    iracingFolderName: opts.iracingFolder,
    carName: opts.car.name,
    assetUrl,
  };
}

export async function runShopBulkDownload(opts: {
  shopSlug: string;
  cars: CarInClass[];
  trackName: string;
  serverUrl: string;
  year: number;
  quarter: number;
  overrides: Record<string, string>;
  onProgress: (event: {
    currentIndex: number;
    total: number;
    car: CarInClass;
    status: "ok" | "skipped" | "error";
    message: string;
  }) => void;
}): Promise<void> {
  const { shopSlug, cars, trackName, serverUrl, year, quarter, overrides, onProgress } = opts;
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    const folder = overrides[car.name] ?? defaultFolderForCar(car.iracingFolderName);
    if (!folder) {
      onProgress({
        currentIndex: i + 1,
        total: cars.length,
        car,
        status: "skipped",
        message: `${car.name} has no iRacing folder — set in Manage Folders`,
      });
      continue;
    }
    const args = buildDownloadArgs({
      car,
      shopSlug,
      trackName,
      iracingFolder: folder,
      serverUrl,
      year,
      quarter,
    });
    if (!args) {
      onProgress({
        currentIndex: i + 1,
        total: cars.length,
        car,
        status: "skipped",
        message: `${car.name} — no file ref for ${shopSlug}`,
      });
      continue;
    }
    try {
      const result = await invoke<{ savedTo: string; fileNames: string[] }>("download_setups", { args });
      const count = result.fileNames.length;
      onProgress({
        currentIndex: i + 1,
        total: cars.length,
        car,
        status: "ok",
        message: `${count} file${count !== 1 ? "s" : ""} → ${result.savedTo}`,
      });
    } catch (err) {
      onProgress({
        currentIndex: i + 1,
        total: cars.length,
        car,
        status: "error",
        message: String(err),
      });
    }
  }
}
