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
    tagName: "bridge-v0.4.4",
    publishedAt: "2026-05-10",
    assets: [
      {
        name: "iRacing.Setup.Bridge_0.4.4_x64_en-US.msi",
        sizeBytes: 3289088,
        downloadUrl:
          "https://github.com/ricardosilva1998/iracing-setup-comparison/releases/download/bridge-v0.4.4/iRacing.Setup.Bridge_0.4.4_x64_en-US.msi",
      },
    ],
    body: "Round 35: real wrench logo for the Windows installer, app window, taskbar, and desktop shortcut — replaces the placeholder solid-teal block. Same wrench design as the website favicon for brand consistency.",
  },
  {
    tagName: "bridge-v0.4.3",
    publishedAt: "2026-05-10",
    assets: [
      {
        name: "iRacing.Setup.Bridge_0.4.3_x64_en-US.msi",
        sizeBytes: 3256320,
        downloadUrl:
          "https://github.com/ricardosilva1998/iracing-setup-comparison/releases/download/bridge-v0.4.3/iRacing.Setup.Bridge_0.4.3_x64_en-US.msi",
      },
    ],
    body: "Round 34: fixes the bridge UI freeze (\"crashes for a few seconds and then comes back\") when searching for setups. Tauri commands are now async, so HTTP calls run on the Tokio worker pool instead of blocking the main webview thread. Also fixes the same freeze during downloads and the Settings → Save & Test Connection click.",
  },
  {
    tagName: "bridge-v0.4.2",
    publishedAt: "2026-05-04",
    assets: [
      {
        name: "iRacing.Setup.Bridge_0.4.2_x64_en-US.msi",
        sizeBytes: 3300000,
        downloadUrl:
          "https://github.com/ricardosilva1998/iracing-setup-comparison/releases/download/bridge-v0.4.2/iRacing.Setup.Bridge_0.4.2_x64_en-US.msi",
      },
    ],
    body: "Round 33: Picker track dropdown now sorted by setup count (most → fewest) instead of alphabetical. Zero-count tracks still listed last; alphabetical kept as tiebreaker for equal counts.",
  },
  {
    tagName: "bridge-v0.4.1",
    publishedAt: "2026-05-02",
    assets: [
      {
        name: "iRacing.Setup.Bridge_0.4.1_x64_en-US.msi",
        sizeBytes: 3280896,
        downloadUrl:
          "https://github.com/ricardosilva1998/iracing-setup-comparison/releases/download/bridge-v0.4.1/iRacing.Setup.Bridge_0.4.1_x64_en-US.msi",
      },
    ],
    body: "Round 32: Bulk Download progress bar (current/total %), Manage Folders grouped by class accordions (collapsible), default folder for every car now ends with /Garage 61 - #NAOTRAVO (your saved overrides are preserved as-is).",
  },
  {
    tagName: "bridge-v0.4.0",
    publishedAt: "2026-05-02",
    assets: [
      {
        name: "iRacing.Setup.Bridge_0.4.0_x64_en-US.msi",
        sizeBytes: 3300000,
        downloadUrl:
          "https://github.com/ricardosilva1998/iracing-setup-comparison/releases/download/bridge-v0.4.0/iRacing.Setup.Bridge_0.4.0_x64_en-US.msi",
      },
    ],
    body: "Round 31: Bulk Download tab gains a class multi-select + 7 preset buttons (All / GT3 / GT4 / IMSA Endurance / WEC Hypercar / Formula / TCR). Server-side: BMW M4 GT4 (P1Doks bare name) now merges into BMW M4 G82 GT4 in Manage Folders. iRacing's M4 GT4 EVO stays separate as it's a distinct iRacing setup folder.",
  },
  {
    tagName: "bridge-v0.3.1",
    publishedAt: "2026-05-02",
    assets: [
      {
        name: "iRacing.Setup.Bridge_0.3.1_x64_en-US.msi",
        sizeBytes: 3280896,
        downloadUrl:
          "https://github.com/ricardosilva1998/iracing-setup-comparison/releases/download/bridge-v0.3.1/iRacing.Setup.Bridge_0.3.1_x64_en-US.msi",
      },
    ],
    body: "Round 30-fix: Picker HYMO Download All no longer fails with 'invalid datapack_id'. Rust now skips datapack_id validation when asset_url is provided (HYMO and future non-GnG shops).",
  },
  {
    tagName: "bridge-v0.3.0",
    publishedAt: "2026-05-01",
    assets: [
      {
        name: "iRacing.Setup.Bridge_0.3.0_x64_en-US.msi",
        sizeBytes: 3280896,
        downloadUrl:
          "https://github.com/ricardosilva1998/iracing-setup-comparison/releases/download/bridge-v0.3.0/iRacing.Setup.Bridge_0.3.0_x64_en-US.msi",
      },
    ],
    body: "Round 30: HYMO file-download pipeline. Bulk Download tab now downloads HYMO setups alongside Grid-and-Go. Picker per-shop section also gets a Download All button for HYMO entries. Two-step API integration with auto-handled ZIP-in-ZIP delivery quirk.",
  },
  {
    tagName: "bridge-v0.2.1",
    publishedAt: "2026-04-30",
    assets: [
      {
        name: "iRacing.Setup.Bridge_0.2.1_x64_en-US.msi",
        sizeBytes: 3300000,
        downloadUrl:
          "https://github.com/ricardosilva1998/iracing-setup-comparison/releases/download/bridge-v0.2.1/iRacing.Setup.Bridge_0.2.1_x64_en-US.msi",
      },
    ],
    body: "Round 27-fix: in-app updater 404 fixed (workflow's manifest URL no longer uses Tauri's spaces-in-filename format; uses the dotted name actually present on the release). Manage Folders tab now scrolls — the 113-car list is fully reachable.",
  },
  {
    tagName: "bridge-v0.2.0",
    publishedAt: "2026-04-30",
    assets: [
      {
        name: "iRacing.Setup.Bridge_0.2.0_x64_en-US.msi",
        sizeBytes: 3300000,
        downloadUrl:
          "https://github.com/ricardosilva1998/iracing-setup-comparison/releases/download/bridge-v0.2.0/iRacing.Setup.Bridge_0.2.0_x64_en-US.msi",
      },
    ],
    body: "Round 27: bulk download for an entire shop + week in one click. New Manage Folders tab to set the iRacing target folder per car (persistent across runs). New Picker 'Save for this car' button. Significant version bump (0.1.x → 0.2.0) since this is a major feature drop.",
  },
  {
    tagName: "bridge-v0.1.9",
    publishedAt: "2026-04-30",
    assets: [
      {
        name: "iRacing.Setup.Bridge_0.1.9_x64_en-US.msi",
        sizeBytes: 3210000,
        downloadUrl:
          "https://github.com/ricardosilva1998/iracing-setup-comparison/releases/download/bridge-v0.1.9/iRacing.Setup.Bridge_0.1.9_x64_en-US.msi",
      },
    ],
    body: "Round 26: Browse… picker now preserves the path relative to your iRacing Setups Root. Picking <root>/porsche9922cup/myfolder now yields the relative path porsche9922cup/myfolder (was just myfolder before — files landed in the wrong place). Edge cases: picking outside root falls back to basename with a hint; picking root itself shows an error.",
  },
  {
    tagName: "bridge-v0.1.8",
    publishedAt: "2026-04-30",
    assets: [
      {
        name: "iRacing.Setup.Bridge_0.1.8_x64_en-US.msi",
        sizeBytes: 3272704,
        downloadUrl:
          "https://github.com/ricardosilva1998/iracing-setup-comparison/releases/download/bridge-v0.1.8/iRacing.Setup.Bridge_0.1.8_x64_en-US.msi",
      },
    ],
    body: "Round 25-fix: visible Windows installer (was hidden behind the app on v0.1.7 — that's why your Install hung). Download progress bar + 30s 'check the taskbar' hint after the installer launches.",
  },
  {
    tagName: "bridge-v0.1.7",
    publishedAt: "2026-04-30",
    assets: [
      {
        name: "iRacing.Setup.Bridge_0.1.7_x64_en-US.msi",
        sizeBytes: 3272704,
        downloadUrl:
          "https://github.com/ricardosilva1998/iracing-setup-comparison/releases/download/bridge-v0.1.7/iRacing.Setup.Bridge_0.1.7_x64_en-US.msi",
      },
    ],
    body: "Round 25: native Windows folder picker (Browse… buttons) for both Settings → iRacing Setups Root and Picker → iRacing folder. No more typing folder names. From v0.1.6+ you can install this via Settings → Check for Updates inside the app.",
  },
  {
    tagName: "bridge-v0.1.6",
    publishedAt: "2026-04-30",
    assets: [
      {
        name: "iRacing.Setup.Bridge_0.1.6_x64_en-US.msi",
        sizeBytes: 3207168,
        downloadUrl:
          "https://github.com/ricardosilva1998/iracing-setup-comparison/releases/download/bridge-v0.1.6/iRacing.Setup.Bridge_0.1.6_x64_en-US.msi",
      },
    ],
    body: "Round 24-fix: Tauri v2 capability grants for the updater + process plugins. Fixes 'command plugin:updater|check not allowed by ACL' from v0.1.5. From v0.1.6 onwards the in-app Check for Updates button works.",
  },
  {
    tagName: "bridge-v0.1.5",
    publishedAt: "2026-04-30",
    assets: [
      {
        name: "iRacing.Setup.Bridge_0.1.5_x64_en-US.msi",
        sizeBytes: 3194880,
        downloadUrl:
          "https://github.com/ricardosilva1998/iracing-setup-comparison/releases/download/bridge-v0.1.5/iRacing.Setup.Bridge_0.1.5_x64_en-US.msi",
      },
    ],
    body: "Round 24: iRacing folder mapping (39 cars) — files now land in the correct iRacing setup folder (e.g. porsche9922cup, not porsche-911-cup-9922). Editable folder input pre-filled with the mapped value; manual override available for cars without a confirmed mapping. Update via Settings → Check for Updates if you're already on v0.1.4.",
  },
  {
    tagName: "bridge-v0.1.4",
    publishedAt: "2026-04-30",
    assets: [
      {
        name: "iRacing.Setup.Bridge_0.1.4_x64_en-US.msi",
        sizeBytes: 3194880,
        downloadUrl:
          "https://github.com/ricardosilva1998/iracing-setup-comparison/releases/download/bridge-v0.1.4/iRacing.Setup.Bridge_0.1.4_x64_en-US.msi",
      },
    ],
    body: "Round 23-fix: in-app updater now works against the private repo via a server-side proxy. Picker no longer 400s after selecting Week/Track/Car (Car interface mismatch fixed). From v0.1.4 onwards, future updates install from inside the app via Settings → Check for Updates.",
  },
  {
    tagName: "bridge-v0.1.3",
    publishedAt: "2026-04-30",
    assets: [
      {
        name: "iRacing.Setup.Bridge_0.1.3_x64_en-US.msi",
        sizeBytes: 3194880,
        downloadUrl:
          "https://github.com/ricardosilva1998/iracing-setup-comparison/releases/download/bridge-v0.1.3/iRacing.Setup.Bridge_0.1.3_x64_en-US.msi",
      },
    ],
    body: "Round 23: Tauri updater plugin (in-app updates from v0.1.4 onwards), dark-window background fix, localeCompare crash on Week select fixed, Check for Updates UI in Settings.",
  },
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
