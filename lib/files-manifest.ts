/**
 * Shared manifest logic for the GnG file-download cache.
 *
 * Used by:
 *   - app/api/files/[datapackId]/route.ts  (thin wrapper returning JSON)
 *   - app/admin/files/[datapackId]/page.tsx (server component calling directly)
 *
 * Extracting here avoids the admin page needing to make a self-credentialed
 * Basic Auth HTTP call back to the API route.
 */
import { mkdir, writeFile, readdir, stat } from "fs/promises";
import { join } from "path";
import { getGngTokens, invalidateGngTokenCache, sanitise } from "@/lib/scrape/grid-and-go-auth";

export type FileEntry = { name: string; sizeBytes: number | null };
export type Manifest = { datapackId: string; files: FileEntry[]; cached: boolean };

const API_HOST = "https://oaseb2ya72.execute-api.eu-central-1.amazonaws.com";

function resolveFilesCacheRoot(): string {
  const dbPath = process.env.DATABASE_PATH;
  if (dbPath) {
    const dir = dbPath.replace(/\/[^/]+$/, "");
    return join(dir, "files");
  }
  return join(process.cwd(), "data", "files");
}

const FILES_CACHE_ROOT = resolveFilesCacheRoot();

// Module-scope semaphore: only 1 concurrent GnG download at a time.
let fetchInFlight = false;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function jitteredDelay() {
  return 5000 + Math.random() * 2000;
}

/** Sanitise a filename from an external source. Returns null if unsafe. */
export function sanitiseFilename(raw: string): string | null {
  const name = raw.trim();
  if (!name) return null;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  if (name.startsWith(".")) return null;
  if (!/^[a-zA-Z0-9._\- ]+$/.test(name)) return null;
  return name;
}

/** Validate that a datapackId looks like a GnG short ID. */
export function validateDatapackId(id: string): boolean {
  return /^[a-zA-Z0-9]{4,30}$/.test(id);
}

type GngFile = { name: string; url: string };

type GngDatapackDetail = {
  id?: string;
  setupLinks?: GngFile[];
  fileLinks?: GngFile[];
  [key: string]: unknown;
};

async function fetchDatapackDetail(datapackId: string): Promise<GngDatapackDetail> {
  const tryWith = async (token: string): Promise<Response> =>
    fetch(`${API_HOST}/datapacks/${datapackId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    });

  let tokens = await getGngTokens();

  let resp = await tryWith(tokens.accessToken);
  if (resp.status === 401) resp = await tryWith(tokens.idToken);

  if (resp.status === 401) {
    invalidateGngTokenCache();
    tokens = await getGngTokens();
    resp = await tryWith(tokens.accessToken);
    if (resp.status === 401) resp = await tryWith(tokens.idToken);
  }

  if (resp.status === 403 || resp.status === 404) {
    const e = Object.assign(new Error(`datapack not found (${resp.status})`), { httpStatus: 404 });
    throw e;
  }
  if (!resp.ok) {
    throw new Error(`GnG API returned ${resp.status}`);
  }

  return resp.json() as Promise<GngDatapackDetail>;
}

async function downloadAndCache(cacheDir: string, filename: string, signedUrl: string): Promise<void> {
  const resp = await fetch(signedUrl, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) {
    throw new Error(`S3 download ${resp.status} for ${filename}`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  await writeFile(join(cacheDir, filename), buffer);
}

/**
 * Returns the manifest for a datapack, fetching from GnG on cache miss.
 *
 * Throws an error with an optional `httpStatus` property on non-retriable
 * failures (404, GnG auth failure). The caller is responsible for converting
 * this to an appropriate HTTP response or error UI.
 *
 * Throws with `httpStatus: 429` when another fetch is already in flight.
 */
export async function getOrFetchManifest(datapackId: string): Promise<Manifest> {
  const cacheDir = join(FILES_CACHE_ROOT, datapackId);

  // Cache hit: directory exists and contains at least one file.
  try {
    const entries = await readdir(cacheDir);
    const files = entries.filter((e) => !e.startsWith("."));
    if (files.length > 0) {
      const manifest = await Promise.all(
        files.map(async (name) => {
          const s = await stat(join(cacheDir, name)).catch(() => null);
          return { name, sizeBytes: s?.size ?? null };
        }),
      );
      console.log(`[files] cache hit: ${datapackId} (${files.length} files)`);
      return { datapackId, files: manifest, cached: true };
    }
  } catch {
    // Directory absent — fall through to fetch.
  }

  // Cache miss: enforce single-flight semaphore.
  if (fetchInFlight) {
    const e = Object.assign(
      new Error("A download is already in progress. Retry in a few seconds."),
      { httpStatus: 429 },
    );
    throw e;
  }
  fetchInFlight = true;

  try {
    await sleep(jitteredDelay());

    console.log(`[files] fetching detail for datapack: ${datapackId}`);

    let detail: GngDatapackDetail;
    try {
      detail = await fetchDatapackDetail(datapackId);
    } catch (err) {
      const e = err as Error & { httpStatus?: number };
      const msg = sanitise(e.message ?? "Unknown error", []);
      console.error(`[files] fetchDatapackDetail error: ${msg}`);
      throw err;
    }

    const rawFiles: GngFile[] = [
      ...(Array.isArray(detail.setupLinks) ? detail.setupLinks : []),
      ...(Array.isArray(detail.fileLinks) ? detail.fileLinks : []),
    ];

    if (rawFiles.length === 0) {
      return { datapackId, files: [], cached: false };
    }

    await mkdir(cacheDir, { recursive: true });

    const downloaded: FileEntry[] = [];
    for (const file of rawFiles) {
      const safeName = sanitiseFilename(file.name);
      if (!safeName) {
        console.warn(`[files] skipping unsafe filename: ${String(file.name).slice(0, 80)}`);
        continue;
      }
      try {
        await downloadAndCache(cacheDir, safeName, file.url);
        const s = await stat(join(cacheDir, safeName)).catch(() => null);
        downloaded.push({ name: safeName, sizeBytes: s?.size ?? null });
        console.log(`[files] cached ${datapackId}/${safeName} (${s?.size ?? "?"} bytes)`);
      } catch (err) {
        const msg = sanitise(String((err as Error).message ?? err), []);
        console.error(`[files] download failed for ${safeName}: ${msg}`);
      }
    }

    return { datapackId, files: downloaded, cached: false };
  } finally {
    fetchInFlight = false;
  }
}
