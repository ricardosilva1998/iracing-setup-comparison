// Shared helper functions for bridge-app screens.

import { open as openDialog } from "@tauri-apps/plugin-dialog";

// Mirrors the slugify() function in Rust lib.rs.
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

// Open a folder picker and return a path relative to iracingRoot.
// Returns null if the user cancels.
// Returns { folder, error } where error is non-null when the pick is ambiguous.
export async function browseRelativeFolder(
  iracingRoot: string,
  defaultPath?: string,
): Promise<{ folder: string; error: string | null } | null> {
  const picked = await openDialog({
    directory: true,
    multiple: false,
    defaultPath: defaultPath || iracingRoot || undefined,
  });
  if (typeof picked !== "string" || picked.length === 0) return null;

  const pickedNorm = picked.replace(/\\/g, "/");
  const root = (iracingRoot ?? "").replace(/\\/g, "/").replace(/\/+$/, "");

  if (!root) {
    const segments = pickedNorm.split("/").filter(Boolean);
    const folder = segments[segments.length - 1] ?? pickedNorm;
    return { folder, error: "Set iRacing Setups Root in Settings to enable multi-segment paths." };
  }

  if (pickedNorm === root) {
    // User picked the root itself — not useful as a car folder.
    return { folder: "", error: "Pick a subfolder of the iRacing setups root, not the root itself." };
  }

  if (pickedNorm.startsWith(root + "/")) {
    const folder = pickedNorm.slice(root.length + 1);
    return { folder, error: null };
  }

  // Outside the root: fall back to basename.
  const segments = pickedNorm.split("/").filter(Boolean);
  const folder = segments[segments.length - 1] ?? pickedNorm;
  return { folder, error: "Folder is outside iRacing Setups Root — using basename only." };
}
