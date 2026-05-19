import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { COLOR } from "../../styles";
import type { Track } from "../../types";

interface Props {
  year: number;
  quarter: number;
  weekNum: number;
  onBack: () => void;
  onSelectTrack: (trackId: number, trackName: string) => void;
}

export function TracksView({ year, quarter, weekNum, onBack, onSelectTrack }: Props) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    invoke<{ tracks: Track[] }>("fetch_picker", {
      endpoint: `tracks?weekNum=${weekNum}&year=${year}&quarter=${quarter}`,
    })
      .then((data) => {
        const rows = Array.isArray(data.tracks) ? data.tracks : [];
        const sorted = [...rows].sort((a, b) => {
          const ac = a.setupCount ?? 0;
          const bc = b.setupCount ?? 0;
          if (bc !== ac) return bc - ac;
          return (a.name ?? "").localeCompare(b.name ?? "");
        });
        setTracks(sorted);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [year, quarter, weekNum]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <button onClick={onBack} style={{
        alignSelf: "flex-start", background: "none", border: "none",
        color: COLOR.accent, cursor: "pointer", fontSize: 13, padding: 0,
      }}>
        ← Back to weeks
      </button>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
        Week {weekNum} — pick a track
      </h1>
      {error && (
        <div style={{
          padding: "0.5rem 0.75rem", backgroundColor: "#451a1a",
          border: `1px solid ${COLOR.red}`, borderRadius: 6,
          color: COLOR.red, fontSize: 13,
        }}>{error}</div>
      )}
      {loading && <div style={{ color: COLOR.muted, fontSize: 13 }}>Loading tracks…</div>}
      {!loading && tracks.length === 0 && !error && (
        <div style={{ color: COLOR.muted, fontSize: 13 }}>
          No setups for any track this week.
        </div>
      )}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        gap: "0.75rem",
      }}>
        {tracks.map((t) => (
          <button
            key={t.id}
            onClick={() => onSelectTrack(t.id, t.name)}
            style={{
              display: "flex", flexDirection: "column", justifyContent: "space-between",
              height: 96, padding: "0.7rem 0.85rem", backgroundColor: COLOR.surface,
              border: `1px solid ${COLOR.border}`, borderRadius: 8, color: COLOR.text,
              cursor: "pointer", textAlign: "left",
              transition: "transform 0.1s, box-shadow 0.1s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "translateY(-1px)";
              e.currentTarget.style.boxShadow = "0 2px 6px rgba(0,0,0,0.4)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "";
              e.currentTarget.style.boxShadow = "";
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.25, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{t.name}</span>
            <span style={{ fontSize: 12, color: COLOR.muted }}>
              {t.setupCount} {t.setupCount === 1 ? "setup" : "setups"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
