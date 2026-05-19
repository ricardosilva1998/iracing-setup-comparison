import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { COLOR, styles } from "../styles";
import type { Settings, Season, PickerView } from "../types";
import { WeeksView } from "./picker/WeeksView";
import { TracksView } from "./picker/TracksView";
import { TrackDetailView } from "./picker/TrackDetailView";

interface Props {
  settings: Settings;
  overrides: Record<string, string>;
  onOverridesChanged?: () => void;
}

export function PickerScreen({ settings, overrides }: Props) {
  const [year, setYear] = useState<number | null>(null);
  const [quarter, setQuarter] = useState<number | null>(null);
  const [activeYear, setActiveYear] = useState<number | null>(null);
  const [activeQuarter, setActiveQuarter] = useState<number | null>(null);
  const [view, setView] = useState<PickerView>({ kind: "weeks" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<{ seasons: Season[] }>("fetch_picker", { endpoint: "seasons" })
      .then((data) => {
        const first = data.seasons[0];
        if (first) {
          setYear(first.year);
          setQuarter(first.quarter);
          setActiveYear(first.year);
          setActiveQuarter(first.quarter);
        } else {
          setError("No seasons available. Run `npm run db:seed` on the server.");
        }
      })
      .catch((err) => setError(String(err)));
  }, []);

  function handleSelectSeason(y: number, q: number) {
    setYear(y);
    setQuarter(q);
    setView({ kind: "weeks" });
  }

  function handleSelectWeek(weekNum: number) {
    setView({ kind: "tracks", weekNum });
  }

  function handleSelectTrack(trackId: number) {
    if (view.kind !== "tracks") return;
    setView({ kind: "track-detail", weekNum: view.weekNum, trackId });
  }

  function backToWeeks() {
    setView({ kind: "weeks" });
  }

  function backToTracks() {
    if (view.kind === "track-detail") {
      setView({ kind: "tracks", weekNum: view.weekNum });
    }
  }

  const isCurrentSeason =
    year !== null &&
    quarter !== null &&
    year === activeYear &&
    quarter === activeQuarter;

  return (
    <div style={styles.screen}>
      {error && (
        <div style={styles.errorBanner} role="alert">
          <span style={{ flex: 1 }}>{error}</span>
          <button
            onClick={() => setError(null)}
            style={styles.errorClose}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}
      {year === null || quarter === null ? (
        <div style={{ color: COLOR.muted, fontSize: 13 }}>Loading seasons…</div>
      ) : view.kind === "weeks" ? (
        <WeeksView
          year={year}
          quarter={quarter}
          onSelectSeason={handleSelectSeason}
          onSelectWeek={handleSelectWeek}
        />
      ) : view.kind === "tracks" ? (
        <TracksView
          year={year}
          quarter={quarter}
          weekNum={view.weekNum}
          onBack={backToWeeks}
          onSelectTrack={handleSelectTrack}
        />
      ) : (
        <TrackDetailView
          year={year}
          quarter={quarter}
          weekNum={view.weekNum}
          trackId={view.trackId}
          isCurrentSeason={isCurrentSeason}
          settings={settings}
          overrides={overrides}
          onBack={backToTracks}
        />
      )}
      <div style={{ ...styles.footer, marginTop: "1rem" }}>
        <span>Server: {settings.serverUrl}</span>
      </div>
    </div>
  );
}
