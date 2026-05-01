/**
 * /releases — public download page for the iRacing Setup Bridge desktop app.
 *
 * Two-tier data strategy:
 *  1. If GITHUB_TOKEN is set (Railway env), fetch live from the GitHub Releases API
 *     (private repo requires auth). Data is ISR-cached for 5 minutes.
 *  2. Otherwise fall back to FALLBACK_RELEASES below. Update this array manually
 *     whenever a new bridge release ships until a GITHUB_TOKEN is configured.
 *
 * To update the fallback when a new release ships, add a new entry at the TOP
 * of FALLBACK_RELEASES with the correct tagName, publishedAt, assets, and body.
 */

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Bridge App Downloads — iRacing Setup Comparison",
  description:
    "Download the iRacing Setup Bridge desktop app to sync setups directly into your iRacing folder.",
};

// ---------------------------------------------------------------------------
// Fallback release list — keep updated when new bridge releases ship.
// Used when GITHUB_TOKEN is not set or the GitHub API request fails.
// ---------------------------------------------------------------------------
const FALLBACK_RELEASES = [
  {
    tagName: "bridge-v0.1.2",
    publishedAt: "2026-04-30",
    assets: [
      {
        name: "iRacing.Setup.Bridge_0.1.0_x64_en-US.msi",
        sizeBytes: 3145728, // ~3.0 MB estimate
        downloadUrl:
          "https://github.com/ricardosilva1998/iracing-setup-comparison/releases/download/bridge-v0.1.2/iRacing.Setup.Bridge_0.1.0_x64_en-US.msi",
      },
    ],
    body: "First public bridge build. Tauri v2 + React UI, picker for Week/Track/Car, GnG file download with OS keychain auth.",
  },
];

// ---------------------------------------------------------------------------
// GitHub Releases API types (subset we use)
// ---------------------------------------------------------------------------
interface GithubAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  published_at: string;
  body: string | null;
  assets: GithubAsset[];
}

interface NormalisedRelease {
  tagName: string;
  publishedAt: string;
  assets: { name: string; sizeBytes: number; downloadUrl: string }[];
  body: string;
}

// ---------------------------------------------------------------------------
// Data fetcher (server-side only)
// ---------------------------------------------------------------------------
async function getReleases(): Promise<{
  releases: NormalisedRelease[];
  source: "api" | "fallback";
}> {
  const token = process.env.GITHUB_TOKEN;

  if (token) {
    try {
      const res = await fetch(
        "https://api.github.com/repos/ricardosilva1998/iracing-setup-comparison/releases?per_page=20",
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
          },
          next: { revalidate: 300 },
        },
      );

      if (res.ok) {
        const data: unknown = await res.json();
        if (Array.isArray(data)) {
          const bridgeReleases = (data as GithubRelease[])
            .filter(
              (r) =>
                r.tag_name.startsWith("bridge-v") &&
                r.assets.some((a) => a.name.endsWith(".msi")),
            )
            .map<NormalisedRelease>((r) => ({
              tagName: r.tag_name,
              publishedAt: r.published_at.slice(0, 10),
              assets: r.assets
                .filter((a) => a.name.endsWith(".msi"))
                .map((a) => ({
                  name: a.name,
                  sizeBytes: a.size,
                  downloadUrl: a.browser_download_url,
                })),
              body: r.body ?? "",
            }));

          if (bridgeReleases.length > 0) {
            return { releases: bridgeReleases, source: "api" };
          }
        }
      } else {
        console.error(
          `[releases] GitHub API returned ${res.status}; falling back to hardcoded list.`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[releases] GitHub API fetch failed: ${msg}; falling back.`);
    }
  }

  return { releases: FALLBACK_RELEASES, source: "fallback" };
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------
export default async function ReleasesPage() {
  const { releases, source } = await getReleases();

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <h1 className="text-3xl font-bold tracking-tight text-gray-100 mb-2">
        iRacing Setup Bridge — Downloads
      </h1>
      <p className="text-gray-400 text-base mb-10">
        Desktop app for downloading setup files directly into your iRacing folder.
        Windows-only.
      </p>

      {releases.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-8 text-center space-y-4">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="w-12 h-12 mx-auto text-gray-600"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
            />
          </svg>
          <p className="text-gray-300 font-medium">No bridge releases yet.</p>
          <p className="text-gray-500 text-sm">
            Check back after the first build ships. The Windows installer (.msi) will appear
            here automatically once published.
          </p>
          <a
            href="https://github.com/ricardosilva1998/iracing-setup-comparison/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block mt-2 text-sm text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors"
          >
            View latest builds on GitHub →
          </a>
        </div>
      ) : (
        <>
          <div className="mb-6 rounded-lg border border-amber-700/40 bg-amber-950/30 px-4 py-3 text-sm text-amber-300">
            Downloads are hosted on GitHub. Since the repo is private, you will need to be
            logged into GitHub in your browser before the download link will work.
          </div>

          <div className="space-y-6">
            {releases.map((release) => (
              <div
                key={release.tagName}
                className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-4"
              >
                <div>
                  <h2 className="text-xl font-semibold text-gray-100">
                    {release.tagName}
                  </h2>
                  <p className="text-xs text-gray-500 mt-0.5">{release.publishedAt}</p>
                </div>

                {release.body && (
                  <p className="text-sm text-gray-400 leading-relaxed">
                    {release.body.slice(0, 200)}
                    {release.body.length > 200 ? "…" : ""}
                  </p>
                )}

                <div className="space-y-2">
                  {release.assets.map((asset) => (
                    <a
                      key={asset.name}
                      href={asset.downloadUrl}
                      className="flex items-center gap-3 rounded-lg border border-gray-700 bg-gray-800 px-4 py-3 hover:border-blue-600 hover:bg-gray-700 transition-colors group"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        className="w-5 h-5 text-blue-400 shrink-0"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
                        />
                      </svg>
                      <span className="flex-1 text-sm text-gray-200 group-hover:text-white font-medium truncate">
                        {asset.name}
                      </span>
                      <span className="text-xs text-gray-500 shrink-0">
                        {(asset.sizeBytes / 1_048_576).toFixed(1)} MB
                      </span>
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <section className="mt-12 space-y-4">
        <h2 className="text-lg font-semibold text-gray-200">How it works</h2>
        <ol className="list-decimal list-inside space-y-2 text-gray-400 text-sm leading-relaxed">
          <li>
            Download and install the <span className="text-gray-200">.msi</span> file above.
          </li>
          <li>
            On first launch, enter your server URL, iRacing setups folder path, and admin
            credentials in the Settings screen.
          </li>
          <li>
            Use the Week / Track / Car dropdowns to browse available setups across all shops.
          </li>
          <li>
            Click <span className="text-gray-200">Download All</span> on a Grid-and-Go entry
            to save the setup files directly into your iRacing folder.
          </li>
        </ol>
      </section>

      <p className="mt-10 text-xs text-gray-500">
        {source === "fallback"
          ? "/releases shows a manually-curated list. Set GITHUB_TOKEN on Railway to auto-update from GitHub Releases."
          : "/releases auto-updates every 5 minutes from GitHub Releases."}
      </p>

      <p className="mt-2 text-xs text-gray-600">
        Not affiliated with iRacing.com or any setup shop. Windows 10 / 11 x64 only.
      </p>
    </div>
  );
}
