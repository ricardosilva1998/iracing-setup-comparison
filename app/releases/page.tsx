/**
 * /releases — public download page for the iRacing Setup Bridge desktop app.
 *
 * TODO: the GitHub repo is currently PRIVATE. The GitHub Releases API
 * (https://api.github.com/repos/ricardosilva1998/iracing-setup-comparison/releases)
 * returns 404 for private repos without auth.
 *
 * To wire real release data, add a read-only Fine-Grained PAT (repo: read metadata +
 * read releases) to Railway and GitHub Actions as GITHUB_TOKEN, then replace the
 * hardcoded empty-state below with:
 *
 *   const res = await fetch(
 *     "https://api.github.com/repos/ricardosilva1998/iracing-setup-comparison/releases?per_page=10",
 *     {
 *       headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
 *       next: { revalidate: 300 },
 *     },
 *   );
 *   const releases = await res.json();
 *
 * Each release asset with a name ending in `.msi` should render as a Download button.
 * Format: release.tag_name, release.published_at (ISO-8601), release.body (markdown),
 * release.assets[].browser_download_url, release.assets[].name.
 */

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Bridge App Downloads — iRacing Setup Comparison",
  description:
    "Download the iRacing Setup Bridge desktop app to sync setups directly into your iRacing folder.",
};

export default function ReleasesPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <h1 className="text-3xl font-bold tracking-tight text-gray-100 mb-2">
        iRacing Setup Bridge — Downloads
      </h1>
      <p className="text-gray-400 text-base mb-10">
        Desktop app for downloading setup files directly into your iRacing folder.
        Windows-only.
      </p>

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

      <p className="mt-10 text-xs text-gray-600">
        Not affiliated with iRacing.com or any setup shop. Windows 10 / 11 x64 only.
      </p>
    </div>
  );
}
