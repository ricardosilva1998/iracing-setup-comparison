/**
 * GET /api/latest-bridge -- public proxy for the Tauri updater.
 *
 * Why this exists: the GitHub repo is private, so Tauri's updater can't fetch
 * latest.json directly from releases/latest/download/latest.json (gets 404).
 * This server-side proxy fetches via a server-side GITHUB_TOKEN and returns
 * the manifest to the desktop app — no token needed by the client.
 *
 * Tauri updater treats:
 *   - 200 + body     → "update available" (uses body as update manifest)
 *   - 204 No Content → "no update available" (clean, no error dialog)
 *   - anything else  → "updater error" (shows a dialog)
 *
 * CORS: Access-Control-Allow-Origin: * because the Tauri updater fetches from
 * a desktop process whose Origin is tauri://localhost or absent — not from a
 * browser context.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const REPO = "ricardosilva1998/iracing-setup-comparison";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "Updater proxy not configured" },
      { status: 503, headers: CORS_HEADERS },
    );
  }

  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Fetch the latest release metadata from GitHub (1-min cache).
  let releaseRes: Response;
  try {
    releaseRes = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: ghHeaders, next: { revalidate: 60 } },
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to reach GitHub API" },
      { status: 502, headers: CORS_HEADERS },
    );
  }

  if (releaseRes.status === 404) {
    // No releases yet — tell the updater "nothing to update".
    return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
  }

  if (releaseRes.status === 401 || releaseRes.status === 403) {
    return NextResponse.json(
      { error: "Updater proxy: GitHub token rejected" },
      { status: 503, headers: CORS_HEADERS },
    );
  }

  if (!releaseRes.ok) {
    return NextResponse.json(
      { error: "Updater proxy: GitHub API error" },
      { status: 502, headers: CORS_HEADERS },
    );
  }

  let release: {
    assets?: Array<{ name: string; url: string; browser_download_url: string }>;
  };
  try {
    release = await releaseRes.json();
  } catch {
    return NextResponse.json(
      { error: "Updater proxy: malformed GitHub response" },
      { status: 502, headers: CORS_HEADERS },
    );
  }

  const asset = release.assets?.find((a) => a.name === "latest.json");
  if (!asset) {
    // Release exists but has no latest.json asset — no update manifest yet.
    return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
  }

  // Fetch the actual latest.json content from the release asset.
  // Private-repo assets: use asset.url (api.github.com path) with
  // Accept: application/octet-stream — browser_download_url returns 404
  // without a browser session even with a valid token.
  let manifestRes: Response;
  try {
    manifestRes = await fetch(asset.url, {
      headers: { ...ghHeaders, Accept: "application/octet-stream" },
      next: { revalidate: 60 },
    });
  } catch {
    return NextResponse.json(
      { error: "Updater proxy: failed to fetch update manifest" },
      { status: 502, headers: CORS_HEADERS },
    );
  }

  if (!manifestRes.ok) {
    return NextResponse.json(
      { error: "Updater proxy: failed to download manifest" },
      { status: 502, headers: CORS_HEADERS },
    );
  }

  const manifest = await manifestRes.text();

  return new NextResponse(manifest, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
    },
  });
}
