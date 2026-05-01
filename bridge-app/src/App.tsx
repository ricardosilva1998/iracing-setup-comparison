import { invoke } from "@tauri-apps/api/core";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Types mirroring Rust serde shapes
// ---------------------------------------------------------------------------

interface Settings {
  serverUrl: string;
  iracingRoot: string;
  hasCredentials: boolean;
}

interface Week {
  weekNum: number;
  label: string;
  setupCount: number;
}

interface Track {
  id: number;
  name: string;
  setupCount: number;
}

interface Car {
  id: number;
  name: string;
  carClass: string;
}

interface ShopFiles {
  shopName: string;
  shopSlug: string;
  datapackId: string | null;
  fileNames: string[];
  cached: boolean;
}

type Screen = "settings" | "picker";

// ---------------------------------------------------------------------------
// Slug helper — mirrors Rust slugify()
// ---------------------------------------------------------------------------

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Error banner
// ---------------------------------------------------------------------------

function ErrorBanner({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div style={styles.errorBanner} role="alert">
      <span style={{ flex: 1 }}>{message}</span>
      <button onClick={onClose} style={styles.errorClose} aria-label="Dismiss error">
        ×
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings screen
// ---------------------------------------------------------------------------

interface SettingsScreenProps {
  initial: Settings | null;
  onSuccess: (settings: Settings) => void;
}

function SettingsScreen({ initial, onSuccess }: SettingsScreenProps) {
  const [serverUrl, setServerUrl] = useState(
    initial?.serverUrl ?? "https://iracing-setup-comparison-production.up.railway.app",
  );
  const [iracingRoot, setIracingRoot] = useState(initial?.iracingRoot ?? "");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [updateState, setUpdateState] = useState<"idle" | "checking" | "uptodate" | "available" | "installing" | "failed">("idle");
  const [updateInfo, setUpdateInfo] = useState<{ version: string; body: string | null | undefined; install: () => Promise<void> } | null>(null);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);

  async function handleSave() {
    setBusy(true);
    setStatus(null);
    try {
      await invoke("save_settings", { settings: { serverUrl, iracingRoot } });
      await invoke("save_credentials", { username, password });
      const result = await invoke<{ ok: boolean; message: string }>("test_connection");
      setStatus(result);
      if (result.ok) {
        const saved: Settings = { serverUrl, iracingRoot, hasCredentials: true };
        setTimeout(() => onSuccess(saved), 800);
      }
    } catch (err) {
      setStatus({ ok: false, message: String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function handleCheckForUpdates() {
    setUpdateState("checking");
    setUpdateMessage(null);
    setUpdateInfo(null);
    try {
      const update = await checkUpdate();
      if (update) {
        setUpdateState("available");
        setUpdateInfo({
          version: update.version,
          body: update.body,
          install: async () => {
            setUpdateState("installing");
            await update.downloadAndInstall();
            await relaunch();
          },
        });
      } else {
        setUpdateState("uptodate");
        setUpdateMessage("You're on the latest version.");
      }
    } catch (e) {
      setUpdateState("failed");
      setUpdateMessage(`Update check failed: ${String(e)}`);
    }
  }

  return (
    <div style={styles.screen}>
      <h1 style={styles.heading}>Settings</h1>
      <p style={styles.subtext}>Configure your server connection and iRacing folder.</p>

      <div style={styles.form}>
        <label style={styles.label}>
          Server URL
          <input
            style={styles.input}
            type="url"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="https://iracing-setup-comparison-production.up.railway.app"
          />
        </label>

        <label style={styles.label}>
          iRacing Setups Root
          <input
            style={styles.input}
            type="text"
            value={iracingRoot}
            onChange={(e) => setIracingRoot(e.target.value)}
            placeholder="%USERPROFILE%\Documents\iRacing\setups\"
          />
        </label>

        <label style={styles.label}>
          Username
          <input
            style={styles.input}
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>

        <label style={styles.label}>
          Password
          <input
            style={styles.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && handleSave()}
          />
        </label>

        {status && (
          <div style={status.ok ? styles.successMsg : styles.errorMsg}>{status.message}</div>
        )}

        <button
          style={busy ? styles.buttonDisabled : styles.button}
          onClick={handleSave}
          disabled={busy}
        >
          {busy ? "Testing..." : "Save & Test Connection"}
        </button>

        <div style={styles.updateSection}>
          <div style={styles.updateDivider} />
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            <button
              style={updateState === "checking" || updateState === "installing" ? styles.buttonDisabled : styles.buttonSecondary}
              onClick={handleCheckForUpdates}
              disabled={updateState === "checking" || updateState === "installing"}
            >
              {updateState === "checking"
                ? "Checking…"
                : updateState === "installing"
                  ? "Installing…"
                  : "Check for Updates"}
            </button>
            {updateState === "uptodate" && (
              <span style={styles.updateMsgOk}>{updateMessage}</span>
            )}
            {updateState === "failed" && (
              <span style={styles.updateMsgError}>{updateMessage}</span>
            )}
          </div>
          {updateState === "available" && updateInfo && (
            <div style={styles.updateAvailableBox}>
              <div style={styles.updateAvailableTitle}>
                Update available: v{updateInfo.version}
              </div>
              {updateInfo.body && (
                <div style={styles.updateNotes}>{updateInfo.body}</div>
              )}
              <button style={styles.button} onClick={updateInfo.install}>
                Download &amp; Install
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Picker screen
// ---------------------------------------------------------------------------

interface PickerScreenProps {
  settings: Settings;
  onOpenSettings: () => void;
}

function PickerScreen({ settings, onOpenSettings }: PickerScreenProps) {
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [cars, setCars] = useState<Car[]>([]);
  const [files, setFiles] = useState<ShopFiles[] | null>(null);

  const [weekNum, setWeekNum] = useState<number | null>(null);
  const [trackId, setTrackId] = useState<number | null>(null);
  const [carId, setCarId] = useState<number | null>(null);

  const [loadingFiles, setLoadingFiles] = useState(false);
  const [downloadStates, setDownloadStates] = useState<Record<string, "idle" | "downloading" | "done" | "error">>({});
  const [downloadMessages, setDownloadMessages] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<{ weeks: Week[] }>("fetch_picker", { endpoint: "weeks" })
      .then((data) => setWeeks(data.weeks))
      .catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    if (weekNum === null) {
      setTracks([]);
      setTrackId(null);
      return;
    }
    invoke<{ tracks: Track[] }>("fetch_picker", { endpoint: `tracks?weekNum=${weekNum}` })
      .then((data) => {
        const rows = Array.isArray(data.tracks) ? data.tracks : [];
        const sorted = [...rows].sort((a, b) => {
          const ac = a.setupCount ?? 0;
          const bc = b.setupCount ?? 0;
          if (bc > 0 && ac === 0) return 1;
          if (ac > 0 && bc === 0) return -1;
          return (a.name ?? "").localeCompare(b.name ?? "");
        });
        setTracks(sorted);
        setTrackId(null);
        setCars([]);
        setCarId(null);
        setFiles(null);
      })
      .catch((err) => setError(String(err)));
  }, [weekNum]);

  useEffect(() => {
    if (weekNum === null || trackId === null) {
      setCars([]);
      setCarId(null);
      return;
    }
    invoke<{ cars: Car[] }>("fetch_picker", {
      endpoint: `cars?weekNum=${weekNum}&trackId=${trackId}`,
    })
      .then((data) => {
        setCars(data.cars);
        setCarId(null);
        setFiles(null);
      })
      .catch((err) => setError(String(err)));
  }, [weekNum, trackId]);

  useEffect(() => {
    if (weekNum === null || trackId === null || carId === null) {
      setFiles(null);
      return;
    }
    setLoadingFiles(true);
    invoke<{ files: ShopFiles[] }>("fetch_picker", {
      endpoint: `files?weekNum=${weekNum}&trackId=${trackId}&carId=${carId}`,
    })
      .then((data) => {
        setFiles(data.files);
        setDownloadStates({});
        setDownloadMessages({});
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoadingFiles(false));
  }, [weekNum, trackId, carId]);

  async function handleDownload(shopFile: ShopFiles, carName: string, trackName: string) {
    if (!shopFile.datapackId) return;
    const key = shopFile.shopSlug;
    setDownloadStates((prev) => ({ ...prev, [key]: "downloading" }));
    try {
      const result = await invoke<{ savedTo: string; fileNames: string[] }>("download_setups", {
        args: {
          carSlug: slugify(carName),
          seasonLabel: "26s2",
          trackSlug: slugify(trackName),
          shopSlug: shopFile.shopSlug,
          datapackId: shopFile.datapackId,
        },
      });
      const count = result.fileNames.length;
      setDownloadStates((prev) => ({ ...prev, [key]: "done" }));
      setDownloadMessages((prev) => ({
        ...prev,
        [key]: `Saved ${count} file${count !== 1 ? "s" : ""} to ${result.savedTo}`,
      }));
    } catch (err) {
      setDownloadStates((prev) => ({ ...prev, [key]: "error" }));
      setDownloadMessages((prev) => ({ ...prev, [key]: String(err) }));
    }
  }

  const selectedCar = cars.find((c) => c.id === carId);
  const selectedTrack = tracks.find((t) => t.id === trackId);

  return (
    <div style={styles.screen}>
      {error && <ErrorBanner message={error} onClose={() => setError(null)} />}

      <div style={styles.pickerHeader}>
        <div style={styles.pickerTitle}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            style={{ width: 22, height: 22 }}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437 1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008Z"
            />
          </svg>
          <span>iRacing Setup Bridge</span>
        </div>
        <button style={styles.settingsBtn} onClick={onOpenSettings}>
          Settings
        </button>
      </div>

      <div style={styles.dropdowns}>
        <div style={styles.dropdownGroup}>
          <label style={styles.dropdownLabel} htmlFor="week-select">
            Week
          </label>
          <select
            id="week-select"
            style={styles.select}
            value={weekNum ?? ""}
            onChange={(e) => setWeekNum(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Select week…</option>
            {weeks.map((w) => (
              <option key={w.weekNum} value={w.weekNum}>
                {w.label} ({w.setupCount} setups)
              </option>
            ))}
          </select>
        </div>

        <div style={styles.dropdownGroup}>
          <label style={styles.dropdownLabel} htmlFor="track-select">
            Track
          </label>
          <select
            id="track-select"
            style={styles.select}
            value={trackId ?? ""}
            onChange={(e) => setTrackId(e.target.value ? Number(e.target.value) : null)}
            disabled={weekNum === null}
          >
            <option value="">Select track…</option>
            {tracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.setupCount ?? 0} setups)
              </option>
            ))}
          </select>
        </div>

        <div style={styles.dropdownGroup}>
          <label style={styles.dropdownLabel} htmlFor="car-select">
            Car
          </label>
          <select
            id="car-select"
            style={styles.select}
            value={carId ?? ""}
            onChange={(e) => setCarId(e.target.value ? Number(e.target.value) : null)}
            disabled={trackId === null}
          >
            <option value="">Select car…</option>
            {cars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.carClass})
              </option>
            ))}
          </select>
        </div>
      </div>

      {loadingFiles && <div style={styles.loadingText}>Loading files…</div>}

      {files && !loadingFiles && (
        <div style={styles.filesPanel}>
          <h2 style={styles.filesHeading}>Available Files</h2>
          {files.map((sf) => {
            const dlState = downloadStates[sf.shopSlug] ?? "idle";
            const dlMsg = downloadMessages[sf.shopSlug];
            return (
              <div key={sf.shopSlug} style={styles.shopRow}>
                <div style={styles.shopInfo}>
                  <span style={styles.shopName}>{sf.shopName}</span>
                  <span style={styles.fileCount}>
                    {sf.datapackId
                      ? sf.fileNames.length > 0
                        ? `${sf.fileNames.length} files cached`
                        : "ready to download"
                      : "no auto-download"}
                  </span>
                </div>
                {sf.datapackId && selectedCar && selectedTrack && (
                  <div style={styles.shopAction}>
                    <button
                      style={
                        dlState === "downloading"
                          ? styles.dlButtonBusy
                          : dlState === "done"
                            ? styles.dlButtonDone
                            : dlState === "error"
                              ? styles.dlButtonError
                              : styles.dlButton
                      }
                      onClick={() =>
                        dlState === "idle" &&
                        handleDownload(sf, selectedCar.name, selectedTrack.name)
                      }
                      disabled={dlState === "downloading" || dlState === "done"}
                    >
                      {dlState === "downloading"
                        ? "Downloading…"
                        : dlState === "done"
                          ? "Downloaded"
                          : dlState === "error"
                            ? "Retry"
                            : "Download All"}
                    </button>
                    {dlMsg && (
                      <span
                        style={dlState === "error" ? styles.dlMsgError : styles.dlMsgOk}
                      >
                        {dlMsg}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {weekNum !== null && trackId !== null && carId === null && !loadingFiles && (
        <div style={styles.hintText}>Select a car to see available files.</div>
      )}

      <div style={styles.footer}>
        <span>Server: {settings.serverUrl}</span>
        <button style={styles.refreshLink} onClick={onOpenSettings}>
          Refresh credentials
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root App — simple screen switcher
// ---------------------------------------------------------------------------

export default function App() {
  const [screen, setScreen] = useState<Screen | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [updateBanner, setUpdateBanner] = useState<string | null>(null);

  useEffect(() => {
    checkUpdate()
      .then((update) => {
        if (update) setUpdateBanner(`Update available: v${update.version} — go to Settings to install.`);
      })
      .catch(() => {
        // Silently ignore startup update-check failures (no network, unsigned build, etc.)
      });
  }, []);

  useEffect(() => {
    invoke<Settings>("get_settings")
      .then((s) => {
        setSettings(s);
        setScreen(s.hasCredentials ? "picker" : "settings");
      })
      .catch((err) => {
        setInitError(String(err));
        setScreen("settings");
        setSettings({
          serverUrl: "https://iracing-setup-comparison-production.up.railway.app",
          iracingRoot: "",
          hasCredentials: false,
        });
      });
  }, []);

  if (screen === null) {
    return <div style={styles.loading}>Loading…</div>;
  }

  if (screen === "settings" || !settings) {
    return (
      <div style={styles.app}>
        {initError && (
          <ErrorBanner message={initError} onClose={() => setInitError(null)} />
        )}
        {updateBanner && (
          <div style={styles.updateBannerBar}>
            <span style={{ flex: 1 }}>{updateBanner}</span>
            <button onClick={() => setUpdateBanner(null)} style={styles.errorClose} aria-label="Dismiss">×</button>
          </div>
        )}
        <SettingsScreen
          initial={settings}
          onSuccess={(s) => {
            setSettings(s);
            setScreen("picker");
          }}
        />
      </div>
    );
  }

  return (
    <div style={styles.app}>
      {updateBanner && (
        <div style={styles.updateBannerBar}>
          <span style={{ flex: 1 }}>{updateBanner}</span>
          <button onClick={() => setUpdateBanner(null)} style={styles.errorClose} aria-label="Dismiss">×</button>
        </div>
      )}
      <PickerScreen
        settings={settings}
        onOpenSettings={() => setScreen("settings")}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles (dark theme, no Tailwind dependency)
// ---------------------------------------------------------------------------

const COLOR = {
  bg: "#030712",
  surface: "#111827",
  border: "#1f2937",
  text: "#f3f4f6",
  muted: "#9ca3af",
  accent: "#3b82f6",
  accentHover: "#2563eb",
  green: "#22c55e",
  red: "#ef4444",
  yellow: "#f59e0b",
};

const styles: Record<string, React.CSSProperties> = {
  app: {
    minHeight: "100vh",
    backgroundColor: COLOR.bg,
    color: COLOR.text,
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: 14,
  },
  loading: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    backgroundColor: COLOR.bg,
    color: COLOR.muted,
  },
  screen: {
    maxWidth: 640,
    margin: "0 auto",
    padding: "2rem 1.5rem",
  },
  heading: {
    fontSize: 22,
    fontWeight: 700,
    margin: "0 0 0.25rem",
  },
  subtext: {
    color: COLOR.muted,
    margin: "0 0 1.5rem",
    fontSize: 13,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: "0.35rem",
    fontSize: 13,
    color: COLOR.muted,
    fontWeight: 500,
  },
  input: {
    backgroundColor: COLOR.surface,
    border: `1px solid ${COLOR.border}`,
    borderRadius: 6,
    padding: "0.5rem 0.75rem",
    color: COLOR.text,
    fontSize: 14,
    outline: "none",
  },
  button: {
    backgroundColor: COLOR.accent,
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "0.6rem 1.25rem",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    marginTop: "0.5rem",
    alignSelf: "flex-start",
  },
  buttonDisabled: {
    backgroundColor: "#374151",
    color: COLOR.muted,
    border: "none",
    borderRadius: 6,
    padding: "0.6rem 1.25rem",
    fontSize: 14,
    fontWeight: 600,
    cursor: "not-allowed",
    marginTop: "0.5rem",
    alignSelf: "flex-start",
  },
  successMsg: {
    backgroundColor: "#052e16",
    border: `1px solid #166534`,
    color: COLOR.green,
    borderRadius: 6,
    padding: "0.5rem 0.75rem",
    fontSize: 13,
  },
  errorMsg: {
    backgroundColor: "#1c0000",
    border: `1px solid #7f1d1d`,
    color: COLOR.red,
    borderRadius: 6,
    padding: "0.5rem 0.75rem",
    fontSize: 13,
  },
  errorBanner: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    backgroundColor: "#1c0000",
    border: `1px solid #7f1d1d`,
    color: COLOR.red,
    padding: "0.5rem 1rem",
    fontSize: 13,
    position: "sticky",
    top: 0,
    zIndex: 10,
  },
  errorClose: {
    background: "none",
    border: "none",
    color: COLOR.red,
    fontSize: 18,
    cursor: "pointer",
    lineHeight: 1,
    padding: 0,
  },
  pickerHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "1.5rem",
  },
  pickerTitle: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    fontSize: 18,
    fontWeight: 700,
  },
  settingsBtn: {
    backgroundColor: COLOR.surface,
    border: `1px solid ${COLOR.border}`,
    color: COLOR.muted,
    borderRadius: 6,
    padding: "0.35rem 0.9rem",
    fontSize: 13,
    cursor: "pointer",
  },
  dropdowns: {
    display: "flex",
    flexDirection: "column",
    gap: "0.9rem",
    marginBottom: "1.5rem",
  },
  dropdownGroup: {
    display: "flex",
    flexDirection: "column",
    gap: "0.3rem",
  },
  dropdownLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: COLOR.muted,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  select: {
    backgroundColor: COLOR.surface,
    border: `1px solid ${COLOR.border}`,
    borderRadius: 6,
    padding: "0.5rem 0.75rem",
    color: COLOR.text,
    fontSize: 14,
    outline: "none",
    cursor: "pointer",
  },
  filesPanel: {
    backgroundColor: COLOR.surface,
    border: `1px solid ${COLOR.border}`,
    borderRadius: 8,
    overflow: "hidden",
    marginBottom: "1.5rem",
  },
  filesHeading: {
    fontSize: 13,
    fontWeight: 600,
    color: COLOR.muted,
    padding: "0.75rem 1rem",
    borderBottom: `1px solid ${COLOR.border}`,
    margin: 0,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  shopRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.75rem",
    padding: "0.75rem 1rem",
    borderBottom: `1px solid ${COLOR.border}`,
  },
  shopInfo: {
    display: "flex",
    flexDirection: "column",
    gap: "0.15rem",
  },
  shopName: {
    fontWeight: 600,
    fontSize: 14,
  },
  fileCount: {
    fontSize: 12,
    color: COLOR.muted,
  },
  shopAction: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "0.25rem",
  },
  dlButton: {
    backgroundColor: COLOR.green,
    color: "#000",
    border: "none",
    borderRadius: 6,
    padding: "0.4rem 0.9rem",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  dlButtonBusy: {
    backgroundColor: "#374151",
    color: COLOR.muted,
    border: "none",
    borderRadius: 6,
    padding: "0.4rem 0.9rem",
    fontSize: 13,
    fontWeight: 600,
    cursor: "wait",
  },
  dlButtonDone: {
    backgroundColor: "#052e16",
    color: COLOR.green,
    border: `1px solid #166534`,
    borderRadius: 6,
    padding: "0.4rem 0.9rem",
    fontSize: 13,
    fontWeight: 600,
    cursor: "default",
  },
  dlButtonError: {
    backgroundColor: "#1c0000",
    color: COLOR.red,
    border: `1px solid #7f1d1d`,
    borderRadius: 6,
    padding: "0.4rem 0.9rem",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  dlMsgOk: {
    fontSize: 11,
    color: COLOR.green,
    maxWidth: 200,
    textAlign: "right",
    wordBreak: "break-all",
  },
  dlMsgError: {
    fontSize: 11,
    color: COLOR.red,
    maxWidth: 200,
    textAlign: "right",
    wordBreak: "break-all",
  },
  loadingText: {
    color: COLOR.muted,
    fontSize: 13,
    marginBottom: "1rem",
  },
  hintText: {
    color: COLOR.muted,
    fontSize: 13,
    marginBottom: "1rem",
  },
  footer: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    color: COLOR.muted,
    fontSize: 12,
    marginTop: "auto",
    paddingTop: "1rem",
    borderTop: `1px solid ${COLOR.border}`,
    flexWrap: "wrap",
  },
  refreshLink: {
    background: "none",
    border: "none",
    color: COLOR.accent,
    fontSize: 12,
    cursor: "pointer",
    padding: 0,
    textDecoration: "underline",
  },
  buttonSecondary: {
    backgroundColor: COLOR.surface,
    color: COLOR.text,
    border: `1px solid ${COLOR.border}`,
    borderRadius: 6,
    padding: "0.6rem 1.25rem",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    alignSelf: "flex-start",
  },
  updateSection: {
    marginTop: "0.5rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
  } as React.CSSProperties,
  updateDivider: {
    height: 1,
    backgroundColor: COLOR.border,
    marginBottom: "0.25rem",
  },
  updateAvailableBox: {
    backgroundColor: "#1c1400",
    border: `1px solid #78350f`,
    borderRadius: 6,
    padding: "0.75rem 1rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  } as React.CSSProperties,
  updateAvailableTitle: {
    fontWeight: 600,
    color: COLOR.yellow,
    fontSize: 14,
  },
  updateNotes: {
    color: COLOR.muted,
    fontSize: 12,
    whiteSpace: "pre-wrap",
    maxHeight: 120,
    overflowY: "auto",
  } as React.CSSProperties,
  updateMsgOk: {
    fontSize: 13,
    color: COLOR.green,
  },
  updateMsgError: {
    fontSize: 13,
    color: COLOR.red,
  },
  updateBannerBar: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    backgroundColor: "#1c1400",
    border: `1px solid #78350f`,
    color: COLOR.yellow,
    padding: "0.5rem 1rem",
    fontSize: 13,
    position: "sticky",
    top: 0,
    zIndex: 10,
  } as React.CSSProperties,
};
