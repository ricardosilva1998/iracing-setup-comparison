/**
 * GET /api/files/hymo/[productId]/[filename]
 *
 * Streams a single cached HYMO setup file to the client as a browser download.
 *
 * Auth: gated by proxy.ts Basic Auth middleware (same as /admin and GnG routes).
 *
 * The file must already exist in the cache directory written by the manifest
 * route (GET /api/files/hymo/[productId]). Returns 404 if not yet cached —
 * the caller should fetch the manifest first to populate the cache.
 */
import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { join } from "path";
import { Readable } from "stream";
import { validateHymoProductId, sanitiseFilename } from "@/lib/scrape/hymo-files";

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

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ productId: string; filename: string }> },
) {
  const { productId, filename } = await params;

  if (!validateHymoProductId(productId)) {
    return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
  }

  const safeName = sanitiseFilename(decodeURIComponent(filename));
  if (!safeName) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  const filePath = join(FILES_CACHE_ROOT, "hymo", productId, safeName);

  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch {
    return NextResponse.json(
      {
        error:
          "File not found in cache. Request the manifest first to populate the cache.",
      },
      { status: 404 },
    );
  }

  const stream = Readable.toWeb(Readable.from(buffer)) as ReadableStream;
  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Content-Length": String(buffer.length),
      "Cache-Control": "no-store",
    },
  });
}
