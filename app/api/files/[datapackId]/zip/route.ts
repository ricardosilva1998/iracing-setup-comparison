/**
 * GET /api/files/[datapackId]/zip
 *
 * Streams all cached setup files for a GnG datapack as a single ZIP archive.
 *
 * Auth: gated by proxy.ts Basic Auth middleware — the `/api/files/:path*`
 *       matcher already covers this path. No additional auth code needed here.
 *
 * Cache-warming: calls getOrFetchManifest which downloads files from GnG on a
 * cache miss (same as the manifest route). On a cache hit the ZIP is built
 * entirely from local volume files — no GnG network call.
 *
 * The response is streamed via a Node.js PassThrough (archiver writes to it,
 * we wrap it with Readable.toWeb() for Next.js). We never buffer the whole
 * archive in memory.
 */
import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "fs";
import { join } from "path";
import { PassThrough, Readable } from "stream";
import archiver from "archiver";
import {
  getOrFetchManifest,
  validateDatapackId,
} from "@/lib/files-manifest";

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
  { params }: { params: Promise<{ datapackId: string }> },
) {
  const { datapackId } = await params;

  if (!validateDatapackId(datapackId)) {
    return NextResponse.json({ error: "Invalid datapack ID" }, { status: 400 });
  }

  // Warm the cache (no-op if files are already on disk).
  let manifest;
  try {
    manifest = await getOrFetchManifest(datapackId);
  } catch (err) {
    const e = err as Error & { httpStatus?: number };
    if (e.httpStatus === 404) {
      return NextResponse.json({ error: "Datapack not found" }, { status: 404 });
    }
    if (e.httpStatus === 429) {
      return NextResponse.json({ error: e.message }, { status: 429 });
    }
    console.error(`[files/zip] cache-warm failed for ${datapackId}: ${e.message}`);
    return NextResponse.json({ error: "Failed to fetch datapack" }, { status: 502 });
  }

  if (manifest.files.length === 0) {
    return NextResponse.json(
      { error: "No files available for this datapack" },
      { status: 404 },
    );
  }

  const cacheDir = join(FILES_CACHE_ROOT, datapackId);

  // Build a streaming ZIP via archiver -> PassThrough -> web ReadableStream.
  // PassThrough is created first so we can hand its web-stream wrapper to the
  // NextResponse before archiver starts writing — avoids buffering the archive.
  const passThrough = new PassThrough();
  const webStream = Readable.toWeb(passThrough) as ReadableStream;

  const archive = archiver("zip", { zlib: { level: 6 } });

  archive.on("error", (err) => {
    console.error(`[files/zip] archiver error for ${datapackId}: ${err.message}`);
    passThrough.destroy(err);
  });

  archive.pipe(passThrough);

  for (const file of manifest.files) {
    const filePath = join(cacheDir, file.name);
    archive.append(createReadStream(filePath), { name: file.name });
  }

  // finalize() triggers archiver to flush all entries and end the stream.
  // Errors surface via the "error" event handler above.
  archive.finalize().catch((err: Error) => {
    console.error(`[files/zip] finalize error for ${datapackId}: ${err.message}`);
  });

  return new NextResponse(webStream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${datapackId}.zip"`,
      // Volume-cached files don't change once written; 1h browser cache is safe.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
