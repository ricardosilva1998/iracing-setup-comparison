/**
 * GET /api/files/[datapackId]
 *
 * Thin wrapper around lib/files-manifest.ts.
 *
 * Auth: gated by Basic Auth via proxy.ts middleware (same as /admin).
 *       The route assumes the request is already authenticated by middleware.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getOrFetchManifest,
  validateDatapackId,
} from "@/lib/files-manifest";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ datapackId: string }> },
) {
  const { datapackId } = await params;

  if (!validateDatapackId(datapackId)) {
    return NextResponse.json({ error: "Invalid datapack ID" }, { status: 400 });
  }

  try {
    const manifest = await getOrFetchManifest(datapackId);
    return NextResponse.json(manifest);
  } catch (err) {
    const e = err as Error & { httpStatus?: number };
    const status = e.httpStatus ?? 500;
    if (status === 404) {
      return NextResponse.json({ error: "Datapack not found" }, { status: 404 });
    }
    if (status === 429) {
      return NextResponse.json({ error: e.message }, { status: 429 });
    }
    return NextResponse.json({ error: "Failed to fetch datapack" }, { status: 500 });
  }
}
