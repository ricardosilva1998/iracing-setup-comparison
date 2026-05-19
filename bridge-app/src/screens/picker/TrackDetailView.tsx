import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { COLOR } from "../../styles";
import type { TrackByClass, Settings } from "../../types";
import { ClassAccordion } from "./ClassAccordion";

interface Props {
  year: number;
  quarter: number;
  weekNum: number;
  trackId: number;
  isCurrentSeason: boolean;
  settings: Settings;
  overrides: Record<string, string>;
  onBack: () => void;
}

export function TrackDetailView({
  year,
  quarter,
  weekNum,
  trackId,
  isCurrentSeason,
  settings,
  overrides,
  onBack,
}: Props) {
  const [data, setData] = useState<TrackByClass | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    invoke<TrackByClass>("fetch_picker", {
      endpoint: `tracks-by-class?weekNum=${weekNum}&trackId=${trackId}&year=${year}&quarter=${quarter}`,
    })
      .then((d) => setData(d))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [year, quarter, weekNum, trackId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <button
        onClick={onBack}
        style={{
          alignSelf: "flex-start",
          background: "none",
          border: "none",
          color: COLOR.accent,
          cursor: "pointer",
          fontSize: 13,
          padding: 0,
        }}
      >
        ← Back to tracks
      </button>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
        {data?.trackName || "Loading…"}
      </h1>
      <div style={{ color: COLOR.muted, fontSize: 13 }}>
        Week {weekNum} — pick a class to expand or download in bulk
      </div>
      {error && (
        <div
          style={{
            padding: "0.5rem 0.75rem",
            backgroundColor: "#451a1a",
            border: `1px solid ${COLOR.red}`,
            borderRadius: 6,
            color: COLOR.red,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}
      {loading && (
        <div style={{ color: COLOR.muted, fontSize: 13 }}>Loading classes…</div>
      )}
      {!loading && data && data.classes.length === 0 && (
        <div style={{ color: COLOR.muted, fontSize: 13 }}>
          No setups for this track this week.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
        {data?.classes.map((g) => (
          <ClassAccordion
            key={g.carClass}
            group={g}
            trackName={data.trackName}
            settings={settings}
            overrides={overrides}
            isCurrentSeason={isCurrentSeason}
            year={year}
            quarter={quarter}
          />
        ))}
      </div>
    </div>
  );
}
