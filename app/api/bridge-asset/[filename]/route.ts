/**
 * GET /api/bridge-asset/[filename] -- public proxy for Tauri updater binary downloads.
 *
 * Why this exists: the GitHub repo is private, so the Tauri updater can't fetch
 * the .msi directly from releases/download/<tag>/<file> (gets 404 without auth).
 * This route fetches the asset via a server-side GITHUB_TOKEN and streams it back
 * to the desktop app — no token needed by the client.
 *
 * Security model: the asset is verified by Tauri's signature check using the
 * embedded public key, so serving without Basic Auth here is safe.
 *
 * CORS: Access-Control-Allow-Origin: * because the Tauri updater fetches from a
 * desktop process whose Origin is tauri://localhost or absent.
 */

import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const REPO = "ricardosilva1998/iracing-setup-comparison";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// Conservative allowlist: alphanumeric + . _ - space, extensions we actually ship.
const SAFE_FILENAME_RE = /^[a-zA-Z0-9._\- ]+\.(msi|sig|exe|zip)$/;

type ReleaseAsset = {
  name: string;
  url: string;
};

type Release = {
  assets?: ReleaseAsset[];
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;

  // Reject path traversal and unsafe characters.
  if (
    !SAFE_FILENAME_RE.test(filename) ||
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    return NextResponse.json(
      { error: "Invalid filename" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "Asset proxy not configured" },
      { status: 503, headers: CORS_HEADERS },
    );
  }

  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Try the latest release first, then walk recent releases.
  const asset = await findAsset(filename, ghHeaders);

  if (!asset) {
    return NextResponse.json(
      { error: "Asset not found in recent releases" },
      { status: 404, headers: CORS_HEADERS },
    );
  }

  // Fetch the binary content. GitHub returns 302 to a short-lived S3 URL;
  // fetch() follows redirects by default. Use asset.url (api.github.com path)
  // with Accept: application/octet-stream — browser_download_url returns 404
  // for private repos even with a valid Bearer token.
  let binaryRes: Response;
  try {
    binaryRes = await fetch(asset.url, {
      headers: { ...ghHeaders, Accept: "application/octet-stream" },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch asset from GitHub" },
      { status: 502, headers: CORS_HEADERS },
    );
  }

  if (!binaryRes.ok) {
    return NextResponse.json(
      { error: "GitHub asset download failed" },
      { status: 502, headers: CORS_HEADERS },
    );
  }

  return new NextResponse(binaryRes.body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Assets are immutable per release version — safe to cache.
      "Cache-Control": "public, max-age=3600",
    },
  });
}

async function findAsset(
  filename: string,
  ghHeaders: Record<string, string>,
): Promise<ReleaseAsset | null> {
  // Try latest release first.
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: ghHeaders },
    );
    if (res.ok) {
      const release: Release = await res.json();
      const match = release.assets?.find((a) => a.name === filename);
      if (match) return match;
    }
  } catch {
    // Fall through to paginated search.
  }

  // Walk recent releases in case the asset is not in the latest.
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases?per_page=20`,
      { headers: ghHeaders },
    );
    if (!res.ok) return null;
    const releases: Release[] = await res.json();
    for (const release of releases) {
      const match = release.assets?.find((a) => a.name === filename);
      if (match) return match;
    }
  } catch {
    // Exhausted options.
  }

  return null;
}
