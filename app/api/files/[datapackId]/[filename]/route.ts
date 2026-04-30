/**
 * GET /api/files/[datapackId]/[filename]
 *
 * Streams a single cached setup file to the client as a browser download.
 *
 * Auth: gated by proxy.ts Basic Auth middleware (same as /admin).
 *
 * The file must already exist in the cache directory written by the manifest
 * route (GET /api/files/[datapackId]). Returns 404 if not yet cached — the
 * caller should fetch the manifest first to populate the cache.
 *
 * Content-Disposition: attachment forces the browser to download rather than
 * attempt to render the binary. All GnG setup file types (.sto, .blap, .rpy)
 * are opaque binary formats with no in-browser renderer.
 */
import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { join } from "path";
import { Readable } from "stream";

export const dynamic = "force-dynamic";

function resolveFilesCacheRoot(): string {
  const dbPath = process.env.DATABASE_PATH;
  if (dbPath) {
    const dir = dbPath.replace(/\/[^/]+$/, "");
    return join(dir, "files");
  }
  return join(process.cwd(), "data", "files");
}

const FILES_CACHE_ROOT = resolveFilesCacheRoot();

function validateDatapackId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{4,40}$/.test(id);
}

function sanitiseFilename(raw: string): string | null {
  const name = raw.trim();
  if (!name) return null;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  if (name.startsWith(".")) return null;
  if (!/^[a-zA-Z0-9._\- ]+$/.test(name)) return null;
  return name;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ datapackId: string; filename: string }> },
) {
  const { datapackId, filename } = await params;

  if (!validateDatapackId(datapackId)) {
    return NextResponse.json({ error: "Invalid datapack ID" }, { status: 400 });
  }

  const safeName = sanitiseFilename(decodeURIComponent(filename));
  if (!safeName) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  const filePath = join(FILES_CACHE_ROOT, datapackId, safeName);

  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch {
    return NextResponse.json(
      { error: "File not found in cache. Request the manifest first to populate the cache." },
      { status: 404 },
    );
  }

  // NextResponse body must be a ReadableStream or Uint8Array (not Node Buffer)
  // when running in the Next.js Node runtime. Convert via Readable.toWeb().
  const stream = Readable.toWeb(Readable.from(buffer)) as ReadableStream;
  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Content-Length": String(buffer.length),
      // No browser caching — always serve fresh from the volume cache.
      "Cache-Control": "no-store",
    },
  });
}
