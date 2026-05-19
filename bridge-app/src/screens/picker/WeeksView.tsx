import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { COLOR } from "../../styles";
import type { Season, Week } from "../../types";

interface Props {
  year: number;
  quarter: number;
  onSelectSeason: (year: number, quarter: number) => void;
  onSelectWeek: (weekNum: number) => void;
}

export function WeeksView({ year, quarter, onSelectSeason, onSelectWeek }: Props) {
  const [seasons, setSeasons] = useState<Season[] | null>(null);
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<{ seasons: Season[] }>("fetch_picker", { endpoint: "seasons" })
      .then((data) => setSeasons(data.seasons))
      .catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    setLoading(true);
    invoke<{ weeks: Week[] }>("fetch_picker", {
      endpoint: `weeks?year=${year}&quarter=${quarter}`,
    })
      .then((data) => setWeeks(data.weeks))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [year, quarter]);

  const currentSeasonValue = `${year}-${quarter}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      {error && (
        <div style={{
          padding: "0.5rem 0.75rem",
          backgroundColor: "#451a1a",
          border: `1px solid ${COLOR.red}`,
          borderRadius: 6,
          color: COLOR.red,
          fontSize: 13,
        }}>{error}</div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <label htmlFor="season-select" style={{
          fontSize: 13, fontWeight: 600, color: COLOR.muted,
          textTransform: "uppercase", letterSpacing: "0.05em",
        }}>Season</label>
        <select
          id="season-select"
          value={currentSeasonValue}
          onChange={(e) => {
            const [y, q] = e.target.value.split("-").map(Number);
            onSelectSeason(y, q);
          }}
          disabled={!seasons}
          style={{
            padding: "0.4rem 0.7rem", backgroundColor: COLOR.surface,
            border: `1px solid ${COLOR.border}`, borderRadius: 6,
            color: COLOR.text, fontSize: 14, minWidth: 180,
          }}
        >
          {seasons === null ? (
            <option>Loading…</option>
          ) : (
            seasons.map((s) => (
              <option key={`${s.year}-${s.quarter}`} value={`${s.year}-${s.quarter}`}>
                {s.label} ({s.setupCount} setups)
              </option>
            ))
          )}
        </select>
      </div>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Pick a week</h1>
      {loading && <div style={{ color: COLOR.muted, fontSize: 13 }}>Loading weeks…</div>}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
        gap: "0.75rem",
      }}>
        {weeks
          .filter((w) => w.weekNum !== 13 || w.setupCount > 0)
          .map((w) => {
            const dim = w.setupCount === 0;
            return (
              <button
                key={w.weekNum}
                onClick={() => !dim && onSelectWeek(w.weekNum)}
                disabled={dim}
                style={{
                  display: "flex", flexDirection: "column", justifyContent: "space-between",
                  height: 96, padding: "0.65rem 0.75rem", backgroundColor: COLOR.surface,
                  border: `1px solid ${COLOR.border}`, borderRadius: 8, color: COLOR.text,
                  cursor: dim ? "default" : "pointer", opacity: dim ? 0.4 : 1,
                  textAlign: "left", transition: "transform 0.1s, box-shadow 0.1s",
                }}
                onMouseEnter={(e) => {
                  if (!dim) {
                    e.currentTarget.style.transform = "translateY(-1px)";
                    e.currentTarget.style.boxShadow = "0 2px 6px rgba(0,0,0,0.4)";
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "";
                  e.currentTarget.style.boxShadow = "";
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 700 }}>{w.label}</span>
                <span style={{ fontSize: 12, color: COLOR.muted }}>
                  {w.setupCount} {w.setupCount === 1 ? "setup" : "setups"}
                </span>
              </button>
            );
          })}
      </div>
    </div>
  );
}
