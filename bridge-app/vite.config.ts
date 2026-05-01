import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only partially overrides
  // the default Vite config. Use camelCase for env variables.
  clearScreen: false,
  server: {
    // Tauri expects a fixed port; fail if unavailable.
    port: 1420,
    strictPort: true,
    watch: {
      // Ignore src-tauri so Rust compilation artefacts don't trigger hot-reloads.
      ignored: ["**/src-tauri/**"],
    },
  },
  // Env variables starting with VITE_ or TAURI_ENV_* are exposed to the webview.
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Tauri supports chrome105 on Windows.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    // Don't minify for debug builds.
    minify: !process.env.TAURI_ENV_DEBUG ? ("esbuild" as const) : false,
    // Produce sourcemaps for debug builds.
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
