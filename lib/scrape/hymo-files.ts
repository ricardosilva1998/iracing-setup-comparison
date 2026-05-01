/**
 * HYMO Setups file-download cache helper.
 *
 * Mirrors lib/files-manifest.ts (GnG) but for HYMO products. Two-step flow
 * confirmed in round 28 probe:
 *   1. POST /api/v1/downloads/links { product_id, type: "manual_download" }
 *      → { downloadURL, expires_in_minutes: 15, ... }
 *   2. GET <downloadURL> with same Bearer token → 200 application/zip
 *
 * Returns the existing Manifest type from lib/files-manifest. Convention:
 * the `datapackId` field holds the HYMO productId string (numeric string).
 * A future round may rename the field to a generic `id`; for now we keep
 * the shared type to avoid a cross-module refactor.
 *
 * Cache directory layout:
 *   <FILES_CACHE_ROOT>/hymo/<productId>/<filename>
 *
 * Module-scope semaphore prevents parallel HYMO downloads.
 */
import { mkdir, readdir, stat, unlink } from "fs/promises";
import { createWriteStream } from "fs";
import { join } from "path";
import { pipeline } from "stream/promises";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";

import type { Manifest, FileEntry } from "@/lib/files-manifest";
export { sanitiseFilename } from "@/lib/files-manifest";
import { sanitiseFilename } from "@/lib/files-manifest";
import {
  getHymoToken,
  invalidateHymoTokenCache,
  sanitise,
} from "@/lib/scrape/hymo-files-auth";

const execAsync = promisify(exec);

const LINKS_URL = "https://api.hymosetups.com/api/v1/downloads/links";

function resolveFilesCacheRoot(): string {
  const dbPath = process.env.DATABASE_PATH;
  if (dbPath) {
    const dir = dbPath.replace(/\/[^/]+$/, "");
    return join(dir, "files");
  }
  return join(process.cwd(), "data", "files");
}

const FILES_CACHE_ROOT = resolveFilesCacheRoot();

// Module-scope semaphore: only 1 concurrent HYMO download at a time.
let fetchInFlight = false;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function jitteredDelay() {
  // 5s + up to 2s jitter, matching the GnG manifest helper.
  return 5000 + Math.random() * 2000;
}

/** Validate that a productId looks like a HYMO numeric ID. */
export function validateHymoProductId(id: string): boolean {
  return /^\d{1,10}$/.test(id);
}

/**
 * Step 1: exchange productId for a signed downloadURL.
 * Handles 401 with retry-once via token invalidation + re-login.
 */
async function fetchDownloadUrl(productId: string): Promise<string> {
  const tryFetch = async (token: string): Promise<Response> =>
    fetch(LINKS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        product_id: parseInt(productId, 10),
        type: "manual_download",
      }),
      signal: AbortSignal.timeout(20000),
    });

  let token = await getHymoToken();
  let resp = await tryFetch(token);

  if (resp.status === 401) {
    invalidateHymoTokenCache();
    token = await getHymoToken();
    resp = await tryFetch(token);
  }

  if (resp.status === 403 || resp.status === 404) {
    const e = Object.assign(
      new Error(`HYMO product not found or not accessible (${resp.status})`),
      { httpStatus: 404 },
    );
    throw e;
  }
  if (!resp.ok) {
    throw new Error(`HYMO links API returned HTTP ${resp.status}`);
  }

  // HYMO response shape: { status: true, data: { downloadURL, expires_in_minutes, ... } }
  const body = (await resp.json()) as { data?: { downloadURL?: string } };
  const downloadURL = body?.data?.downloadURL;
  if (!downloadURL) {
    throw new Error("HYMO links API returned no data.downloadURL");
  }
  return downloadURL;
}

/**
 * Step 2: GET the ZIP from the signed downloadURL, stream it to a temp file,
 * then extract entries into cacheDir using system `unzip` (available on both
 * macOS and Alpine Linux via the standard apk `unzip` package).
 *
 * Temp file is deleted after extraction regardless of success/failure.
 */
async function downloadAndExtract(
  productId: string,
  downloadUrl: string,
  cacheDir: string,
): Promise<FileEntry[]> {
  const token = await getHymoToken();

  const resp = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120000),
  });

  if (!resp.ok) {
    throw new Error(`HYMO download returned HTTP ${resp.status}`);
  }
  if (!resp.body) {
    throw new Error("HYMO download returned empty body");
  }

  // Stream ZIP body to a temp file to avoid OOM on large archives.
  const tmpPath = join(
    tmpdir(),
    `hymo-${productId}-${randomBytes(6).toString("hex")}.zip`,
  );
  const tmpFile = createWriteStream(tmpPath);

  try {
    // resp.body is a Web ReadableStream; pipeline accepts it in Node 18+.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await pipeline(resp.body as any, tmpFile);
  } catch (err) {
    tmpFile.destroy();
    try { await unlink(tmpPath); } catch { /* best-effort */ }
    throw new Error(
      `HYMO download stream error: ${(err as Error).message}`,
    );
  }

  await mkdir(cacheDir, { recursive: true });

  // Sanitise paths for shell execution. Both paths are internally generated
  // (tmpdir + randomBytes for tmp; volume path for cacheDir) so no user input
  // reaches the shell. Single-quote wrapping is defence-in-depth.
  const safeTmp = tmpPath.replace(/'/g, "");
  const safeDest = cacheDir.replace(/'/g, "");
  try {
    await execAsync(`unzip -o -q '${safeTmp}' -d '${safeDest}'`);
  } finally {
    try { await unlink(tmpPath); } catch { /* best-effort */ }
  }

  // HYMO delivers a ZIP-in-ZIP: the outer archive contains a single inner .zip.
  // Detect any .zip files in the extracted directory and re-extract them flat
  // (no sub-directories) into cacheDir, then delete the inner .zip wrappers.
  const afterOuter = await readdir(cacheDir);
  for (const name of afterOuter) {
    if (!name.toLowerCase().endsWith(".zip")) continue;
    const innerZip = join(cacheDir, name);
    const safeInner = innerZip.replace(/'/g, "");
    try {
      // -j: junk (flatten) directory structure; -o: overwrite; -q: quiet.
      await execAsync(`unzip -o -q -j '${safeInner}' -d '${safeDest}'`);
    } catch (err) {
      console.warn(`[hymo-files] inner zip extract failed for ${name}: ${(err as Error).message}`);
    }
    try { await unlink(innerZip); } catch { /* best-effort */ }
  }

  // Build manifest from what was actually extracted (non-zip, non-hidden).
  const entries = await readdir(cacheDir);
  const files: FileEntry[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (name.toLowerCase().endsWith(".zip")) continue; // leftover wrapper
    const safe = sanitiseFilename(name);
    if (!safe) continue;
    const s = await stat(join(cacheDir, name)).catch(() => null);
    files.push({ name: safe, sizeBytes: s?.size ?? null });
    console.log(
      `[hymo-files] cached ${productId}/${safe} (${s?.size ?? "?"} bytes)`,
    );
  }
  return files;
}

/**
 * Returns the manifest for a HYMO product, fetching from HYMO on cache miss.
 *
 * `datapackId` in the returned Manifest holds the productId string
 * (convention documented in the module header above).
 *
 * Throws with `httpStatus: 404` when HYMO returns 403/404 for the product.
 * Throws with `httpStatus: 429` when another fetch is already in flight.
 */
export async function getOrFetchHymoManifest(productId: string): Promise<Manifest> {
  const cacheDir = join(FILES_CACHE_ROOT, "hymo", productId);

  // Cache hit: directory exists and contains at least one non-hidden file.
  try {
    const entries = await readdir(cacheDir);
    const visible = entries.filter(
      (e) => !e.startsWith(".") && !e.toLowerCase().endsWith(".zip"),
    );
    if (visible.length > 0) {
      const manifest = await Promise.all(
        visible.map(async (name) => {
          const s = await stat(join(cacheDir, name)).catch(() => null);
          return { name, sizeBytes: s?.size ?? null };
        }),
      );
      console.log(`[hymo-files] cache hit: ${productId} (${visible.length} files)`);
      return { datapackId: productId, files: manifest, cached: true };
    }
  } catch {
    // Directory absent — fall through to fetch.
  }

  // Cache miss: enforce single-flight semaphore.
  if (fetchInFlight) {
    const e = Object.assign(
      new Error(
        "A HYMO download is already in progress. Retry in a few seconds.",
      ),
      { httpStatus: 429 },
    );
    throw e;
  }
  fetchInFlight = true;

  try {
    await sleep(jitteredDelay());

    console.log(`[hymo-files] fetching download link for product: ${productId}`);

    let downloadUrl: string;
    try {
      downloadUrl = await fetchDownloadUrl(productId);
    } catch (err) {
      const e = err as Error & { httpStatus?: number };
      const msg = sanitise(e.message ?? "Unknown error", []);
      console.error(`[hymo-files] fetchDownloadUrl error: ${msg}`);
      throw err;
    }

    console.log(`[hymo-files] downloading and extracting product ${productId}`);

    let files: FileEntry[];
    try {
      files = await downloadAndExtract(productId, downloadUrl, cacheDir);
    } catch (err) {
      const msg = sanitise(String((err as Error).message ?? err), []);
      console.error(`[hymo-files] extract error for ${productId}: ${msg}`);
      throw err;
    }

    return { datapackId: productId, files, cached: false };
  } finally {
    fetchInFlight = false;
  }
}
