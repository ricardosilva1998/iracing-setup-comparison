import { invoke } from "@tauri-apps/api/core";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { useEffect, useState } from "react";
import { COLOR, styles } from "./styles";
import { SettingsScreen } from "./screens/Settings";
import { PickerScreen } from "./screens/Picker";
import { BulkScreen } from "./screens/Bulk";
import { ManageScreen } from "./screens/Manage";
import type { Settings, Screen } from "./types";

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
// Tab bar — shown on all screens once credentials are saved
// ---------------------------------------------------------------------------

const TABS: { id: Screen; label: string }[] = [
  { id: "picker", label: "Picker" },
  { id: "bulk", label: "Bulk Download" },
  { id: "manage", label: "Manage Folders" },
  { id: "settings", label: "Settings" },
];

function TabBar({
  active,
  onSelect,
}: {
  active: Screen;
  onSelect: (s: Screen) => void;
}) {
  return (
    <nav
      style={{
        display: "flex",
        borderBottom: `1px solid ${COLOR.border}`,
        backgroundColor: COLOR.surface,
        position: "sticky",
        top: 0,
        zIndex: 9,
      }}
    >
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onSelect(tab.id)}
          style={{
            background: "none",
            border: "none",
            borderBottom: active === tab.id ? `2px solid ${COLOR.accent}` : "2px solid transparent",
            color: active === tab.id ? COLOR.text : COLOR.muted,
            padding: "0.65rem 1.1rem",
            fontSize: 13,
            fontWeight: active === tab.id ? 600 : 400,
            cursor: "pointer",
            transition: "color 0.1s",
          }}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// App header (logo row) — always visible
// ---------------------------------------------------------------------------

function AppHeader() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        padding: "0.65rem 1.25rem",
        borderBottom: `1px solid ${COLOR.border}`,
        backgroundColor: COLOR.bg,
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        style={{ width: 20, height: 20, color: COLOR.accent }}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437 1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008Z"
        />
      </svg>
      <span style={{ fontWeight: 700, fontSize: 15 }}>iRacing Setup Bridge</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root App
// ---------------------------------------------------------------------------

export default function App() {
  const [screen, setScreen] = useState<Screen | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [updateBanner, setUpdateBanner] = useState<string | null>(null);
  // Overrides map cached at app level; refreshed whenever any screen saves/clears.
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  useEffect(() => {
    checkUpdate()
      .then((update) => {
        if (update)
          setUpdateBanner(`Update available: v${update.version} — go to Settings to install.`);
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

  // Load overrides once on mount, and whenever onOverridesChanged is called.
  async function refreshOverrides() {
    try {
      const result = await invoke<Record<string, string>>("get_car_folder_overrides");
      setOverrides(result);
    } catch {
      // Non-fatal: overrides stay at their last known value.
    }
  }

  useEffect(() => {
    refreshOverrides();
  }, []);

  if (screen === null) {
    return <div style={styles.loading}>Loading…</div>;
  }

  // Before credentials are saved: show only the Settings screen without the tab bar.
  if (!settings?.hasCredentials || screen === "settings") {
    return (
      <div style={styles.app}>
        {initError && (
          <ErrorBanner message={initError} onClose={() => setInitError(null)} />
        )}
        {updateBanner && (
          <div style={styles.updateBannerBar}>
            <span style={{ flex: 1 }}>{updateBanner}</span>
            <button
              onClick={() => setUpdateBanner(null)}
              style={styles.errorClose}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        <AppHeader />
        {settings?.hasCredentials && (
          <TabBar active="settings" onSelect={(s) => setScreen(s)} />
        )}
        <SettingsScreen
          initial={settings}
          onSuccess={(s) => {
            setSettings(s);
            refreshOverrides();
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
          <button
            onClick={() => setUpdateBanner(null)}
            style={styles.errorClose}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      <AppHeader />
      <TabBar active={screen} onSelect={(s) => setScreen(s)} />

      {screen === "picker" && (
        <PickerScreen
          settings={settings}
          overrides={overrides}
          onOverridesChanged={refreshOverrides}
        />
      )}
      {screen === "bulk" && (
        <BulkScreen
          settings={settings}
          overrides={overrides}
        />
      )}
      {screen === "manage" && (
        <ManageScreen
          settings={settings}
          overrides={overrides}
          onOverridesChanged={refreshOverrides}
        />
      )}
    </div>
  );
}
