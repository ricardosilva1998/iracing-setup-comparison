import Link from "next/link";
import { getOrFetchManifest, validateDatapackId } from "@/lib/files-manifest";

type Params = Promise<{ datapackId: string }>;

function formatSize(bytes: number | null): string {
  if (bytes == null) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default async function AdminFilesPage({ params }: { params: Params }) {
  const { datapackId } = await params;

  if (!validateDatapackId(datapackId)) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-4">
        <div className="text-sm text-gray-500">
          <Link href="/admin" className="hover:text-gray-300 transition-colors">
            &larr; Back to admin
          </Link>
        </div>
        <p className="text-rose-400 text-sm">Invalid datapack ID.</p>
      </div>
    );
  }

  type ManifestResult =
    | { ok: true; manifest: Awaited<ReturnType<typeof getOrFetchManifest>> }
    | { ok: false; message: string; status: number };

  let result: ManifestResult;
  try {
    const manifest = await getOrFetchManifest(datapackId);
    result = { ok: true, manifest };
  } catch (err) {
    const e = err as Error & { httpStatus?: number };
    const status = e.httpStatus ?? 500;
    let message: string;
    if (status === 404) {
      message =
        "Datapack not found on Grid-and-Go (404). The ID may be wrong or the pack may have been removed.";
    } else if (status === 429) {
      message =
        "A download is already in progress. Refresh the page in a few seconds to retry.";
    } else {
      message =
        "Failed to fetch files from Grid-and-Go. Check that GRID_AND_GO_EMAIL and GRID_AND_GO_PASSWORD are set and valid.";
    }
    result = { ok: false, message, status };
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <header className="space-y-1">
        <div className="text-sm text-gray-500">
          <Link href="/admin" className="hover:text-gray-300 transition-colors">
            &larr; Back to admin
          </Link>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Setup files</h1>
        <p className="text-sm text-gray-400 font-mono">{datapackId}</p>
      </header>

      {!result.ok ? (
        <div className="rounded-md border border-rose-800 bg-rose-950/40 px-5 py-4">
          <p className="text-sm text-rose-300">{result.message}</p>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 text-sm text-gray-400">
            <span>
              {result.manifest.files.length} file
              {result.manifest.files.length !== 1 ? "s" : ""}
            </span>
            <span className="text-gray-700">&middot;</span>
            <span
              className={
                result.manifest.cached ? "text-emerald-400" : "text-amber-400"
              }
            >
              {result.manifest.cached
                ? "served from cache"
                : "freshly fetched from Grid-and-Go"}
            </span>
          </div>

          {result.manifest.files.length === 0 ? (
            <div className="rounded-md border border-gray-800 bg-gray-900/40 px-5 py-4">
              <p className="text-sm text-gray-500 italic">
                No files found for this datapack. The pack may not include
                downloadable setup files.
              </p>
            </div>
          ) : (
            <div className="rounded-md border border-gray-800 bg-gray-900/40 overflow-hidden">
              <table className="min-w-full text-sm text-gray-300">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wider">
                    <th className="px-4 py-2 text-left">File</th>
                    <th className="px-4 py-2 text-right">Size</th>
                    <th className="px-4 py-2 text-right">Download</th>
                  </tr>
                </thead>
                <tbody>
                  {result.manifest.files.map((file) => (
                    <tr
                      key={file.name}
                      className="border-b border-gray-800/50 last:border-0"
                    >
                      <td className="px-4 py-2 font-mono text-gray-100 break-all">
                        {file.name}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-400 whitespace-nowrap">
                        {formatSize(file.sizeBytes)}
                      </td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        <a
                          href={`/api/files/${datapackId}/${encodeURIComponent(file.name)}`}
                          download={file.name}
                          className="inline-flex items-center gap-1 rounded bg-blue-800 hover:bg-blue-700 transition-colors px-3 py-1 text-xs font-medium text-white"
                        >
                          Download
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
