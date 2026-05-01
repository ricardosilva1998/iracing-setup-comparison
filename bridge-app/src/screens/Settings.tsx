import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useState } from "react";
import { styles } from "../styles";
import type { Settings } from "../types";

interface Props {
  initial: Settings | null;
  onSuccess: (settings: Settings) => void;
}

export function SettingsScreen({ initial, onSuccess }: Props) {
  const [serverUrl, setServerUrl] = useState(
    initial?.serverUrl ?? "https://iracing-setup-comparison-production.up.railway.app",
  );
  const [iracingRoot, setIracingRoot] = useState(initial?.iracingRoot ?? "");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [updateState, setUpdateState] = useState<
    "idle" | "checking" | "uptodate" | "available" | "installing" | "failed"
  >("idle");
  const [updateInfo, setUpdateInfo] = useState<{
    version: string;
    body: string | null | undefined;
    install: () => Promise<void>;
  } | null>(null);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<{
    downloaded: number;
    total: number;
    phase: "downloading" | "launching";
  } | null>(null);
  const [launchingHintVisible, setLaunchingHintVisible] = useState(false);

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

  async function handleBrowseRoot() {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: iracingRoot || undefined,
    });
    if (typeof picked === "string" && picked.length > 0) {
      setIracingRoot(picked);
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
            setDownloadProgress({ downloaded: 0, total: 0, phase: "downloading" });
            setLaunchingHintVisible(false);
            try {
              let downloaded = 0;
              let total = 0;
              await update.downloadAndInstall((event) => {
                switch (event.event) {
                  case "Started":
                    total = event.data?.contentLength ?? 0;
                    setDownloadProgress({ downloaded: 0, total, phase: "downloading" });
                    break;
                  case "Progress":
                    downloaded += event.data?.chunkLength ?? 0;
                    setDownloadProgress({ downloaded, total, phase: "downloading" });
                    break;
                  case "Finished":
                    setDownloadProgress({ downloaded: total, total, phase: "launching" });
                    setTimeout(() => setLaunchingHintVisible(true), 30_000);
                    break;
                }
              });
              await relaunch();
            } catch (e) {
              setUpdateState("failed");
              setUpdateMessage(`Install failed: ${String(e)}`);
              setDownloadProgress(null);
            }
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
          <div style={styles.inputRow}>
            <input
              style={{ ...styles.input, flex: 1 }}
              type="text"
              value={iracingRoot}
              onChange={(e) => setIracingRoot(e.target.value)}
              placeholder="%USERPROFILE%\Documents\iRacing\setups\"
            />
            <button style={styles.browseButton} type="button" onClick={handleBrowseRoot}>
              Browse…
            </button>
          </div>
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
              style={
                updateState === "checking" || updateState === "installing"
                  ? styles.buttonDisabled
                  : styles.buttonSecondary
              }
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
          {updateState === "installing" && downloadProgress && (
            <div style={styles.updateProgressBox}>
              {downloadProgress.phase === "downloading" ? (
                <>
                  <div style={styles.updateProgressLabel}>
                    Downloading update…{" "}
                    {downloadProgress.total > 0
                      ? `${(downloadProgress.downloaded / (1024 * 1024)).toFixed(1)} / ${(downloadProgress.total / (1024 * 1024)).toFixed(1)} MB`
                      : downloadProgress.downloaded > 0
                        ? `${(downloadProgress.downloaded / (1024 * 1024)).toFixed(1)} MB`
                        : ""}
                  </div>
                  <div style={styles.updateProgressTrack}>
                    <div
                      style={{
                        ...styles.updateProgressFill,
                        width:
                          downloadProgress.total > 0
                            ? `${Math.min(100, (downloadProgress.downloaded / downloadProgress.total) * 100).toFixed(1)}%`
                            : "0%",
                      }}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div style={styles.updateProgressLabel}>
                    Installer launched — please complete it in the dialog and the app will relaunch.
                  </div>
                  {launchingHintVisible && (
                    <div style={styles.updateProgressHint}>
                      If nothing happened, the installer may be behind another window — check your taskbar.
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
