/**
 * GET /api/files/hymo/[productId]
 *
 * Returns the manifest (list of cached files) for a HYMO product.
 * On cache miss, logs in to HYMO, fetches the ZIP, extracts it to the volume,
 * and returns the resulting file list.
 *
 * Auth: gated by proxy.ts Basic Auth middleware via the `/api/files/:path*`
 *       matcher — no additional auth code needed here.
 *
 * productId must be a numeric string (1–10 digits). HYMO product IDs are
 * always numeric; non-numeric values are rejected with 400.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getOrFetchHymoManifest,
  validateHymoProductId,
} from "@/lib/scrape/hymo-files";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ productId: string }> },
) {
  const { productId } = await params;

  if (!validateHymoProductId(productId)) {
    return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
  }

  try {
    const manifest = await getOrFetchHymoManifest(productId);
    return NextResponse.json(manifest);
  } catch (err) {
    const e = err as Error & { httpStatus?: number };
    const status = e.httpStatus ?? 500;
    if (status === 404) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    if (status === 429) {
      return NextResponse.json({ error: e.message }, { status: 429 });
    }
    return NextResponse.json(
      { error: "Failed to fetch HYMO product" },
      { status: 500 },
    );
  }
}
