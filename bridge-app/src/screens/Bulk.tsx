import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { COLOR, styles } from "../styles";
import { slugify } from "../helpers";
import type { Settings, Week, Track, Car, ShopFiles, BulkLogEntry, BulkProgress } from "../types";

const SHOPS = [
  { label: "Grid-and-Go", slug: "grid-and-go" },
  { label: "HYMO Setups", slug: "hymo" },
  { label: "GO Setups", slug: "gosetups" },
  { label: "Majors Garage", slug: "majors-garage" },
  { label: "P1Doks", slug: "p1doks" },
];

interface Props {
  settings: Settings;
  overrides: Record<string, string>;
}

export function BulkScreen({ settings: _settings, overrides }: Props) {
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [bulkShop, setBulkShop] = useState<string>("grid-and-go");
  const [bulkWeek, setBulkWeek] = useState<number | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);
  const [bulkLog, setBulkLog] = useState<BulkLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<{ weeks: Week[] }>("fetch_picker", { endpoint: "weeks" })
      .then((data) => {
        setWeeks(data.weeks);
        // Default to the week with the highest setupCount.
        const best = [...data.weeks].sort((a, b) => b.setupCount - a.setupCount)[0];
        if (best) setBulkWeek(best.weekNum);
      })
      .catch((err) => setError(String(err)));
  }, []);

  async function handleStartBulk() {
    if (bulkWeek === null || bulkRunning) return;
    setBulkRunning(true);
    setBulkLog([]);
    setBulkProgress(null);
    setError(null);

    try {
      const trackData = await invoke<{ tracks: Track[] }>("fetch_picker", {
        endpoint: `tracks?weekNum=${bulkWeek}`,
      });
      const tracksWithSetups = trackData.tracks.filter((t) => (t.setupCount ?? 0) > 0);

      // Build the full job list so we can show accurate total progress.
      type Job = { track: Track; car: Car; shopFile: ShopFiles; apiFolder: string | null };
      const jobs: Job[] = [];

      for (const track of tracksWithSetups) {
        const carData = await invoke<{ cars: Car[] }>("fetch_picker", {
          endpoint: `cars?weekNum=${bulkWeek}&trackId=${track.id}`,
        });
        for (const car of carData.cars) {
          const fileData = await invoke<{
            files: ShopFiles[];
            iracingFolderName: string | null;
          }>("fetch_picker", {
            endpoint: `files?weekNum=${bulkWeek}&trackId=${track.id}&carId=${car.id}`,
          });
          const shopFile = fileData.files.find((f) => f.shopSlug === bulkShop);
          if (shopFile) {
            jobs.push({ track, car, shopFile, apiFolder: fileData.iracingFolderName });
          }
        }
      }

      const total = jobs.length;

      for (let i = 0; i < jobs.length; i++) {
        const { track, car, shopFile, apiFolder } = jobs[i];

        setBulkProgress({
          current: i + 1,
          total,
          carName: car.name,
          trackName: track.name,
          status: "downloading",
        });

        if (!shopFile.datapackId) {
          const entry: BulkLogEntry = {
            car: car.name,
            track: track.name,
            status: "skipped",
            message: "Shop has no file pipeline for this car/track",
          };
          setBulkLog((prev) => [...prev, entry]);
          setBulkProgress((p) => (p ? { ...p, status: "skipped" } : p));
          continue;
        }

        // Priority: persisted override > API default.
        const folder = overrides[car.name] ?? apiFolder ?? null;

        if (!folder) {
          const entry: BulkLogEntry = {
            car: car.name,
            track: track.name,
            status: "skipped",
            message: `No iRacing folder for ${car.name} — set it in Manage Folders`,
          };
          setBulkLog((prev) => [...prev, entry]);
          setBulkProgress((p) => (p ? { ...p, status: "skipped" } : p));
          continue;
        }

        try {
          const result = await invoke<{ savedTo: string; fileNames: string[] }>(
            "download_setups",
            {
              args: {
                carSlug: slugify(car.name),
                seasonLabel: "26s2",
                trackSlug: slugify(track.name),
                shopSlug: bulkShop,
                datapackId: shopFile.datapackId,
                iracingFolderName: folder,
                carName: car.name,
              },
            },
          );
          const count = result.fileNames.length;
          const entry: BulkLogEntry = {
            car: car.name,
            track: track.name,
            status: "ok",
            message: `${count} file${count !== 1 ? "s" : ""} → ${result.savedTo}`,
            folder,
          };
          setBulkLog((prev) => [...prev, entry]);
          setBulkProgress((p) => (p ? { ...p, status: "ok" } : p));
        } catch (err) {
          const entry: BulkLogEntry = {
            car: car.name,
            track: track.name,
            status: "error",
            message: String(err),
          };
          setBulkLog((prev) => [...prev, entry]);
          setBulkProgress((p) => (p ? { ...p, status: "error" } : p));
        }
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBulkRunning(false);
    }
  }

  const okCount = bulkLog.filter((e) => e.status === "ok").length;
  const skippedCount = bulkLog.filter((e) => e.status === "skipped").length;
  const errorCount = bulkLog.filter((e) => e.status === "error").length;
  const isDone = !bulkRunning && bulkLog.length > 0;

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

      <h1 style={styles.heading}>Bulk Download</h1>
      <p style={styles.subtext}>
        Download all setups for a shop and week in one click. Car folders must be configured in
        Manage Folders first — cars without a folder mapping are skipped.
      </p>

      <div style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
        <div style={styles.dropdownGroup}>
          <label style={styles.dropdownLabel} htmlFor="bulk-shop-select">
            Shop
          </label>
          <select
            id="bulk-shop-select"
            style={styles.select}
            value={bulkShop}
            onChange={(e) => setBulkShop(e.target.value)}
            disabled={bulkRunning}
          >
            {SHOPS.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <div style={styles.dropdownGroup}>
          <label style={styles.dropdownLabel} htmlFor="bulk-week-select">
            Week
          </label>
          <select
            id="bulk-week-select"
            style={styles.select}
            value={bulkWeek ?? ""}
            onChange={(e) => setBulkWeek(e.target.value ? Number(e.target.value) : null)}
            disabled={bulkRunning}
          >
            <option value="">Select week…</option>
            {weeks.map((w) => (
              <option key={w.weekNum} value={w.weekNum}>
                {w.label} ({w.setupCount} setups)
              </option>
            ))}
          </select>
        </div>
      </div>

      <button
        style={
          bulkRunning || bulkWeek === null
            ? {
                ...styles.button,
                backgroundColor: "#374151",
                color: COLOR.muted,
                cursor: bulkRunning ? "wait" : "not-allowed",
                marginTop: 0,
              }
            : {
                ...styles.button,
                backgroundColor: COLOR.green,
                color: "#000",
                marginTop: 0,
                fontSize: 15,
                padding: "0.7rem 1.5rem",
              }
        }
        onClick={handleStartBulk}
        disabled={bulkRunning || bulkWeek === null}
      >
        {bulkRunning ? "Running…" : "Start Bulk Download"}
      </button>

      {bulkProgress && (
        <div
          style={{
            marginTop: "1.5rem",
            backgroundColor: COLOR.surface,
            border: `1px solid ${COLOR.border}`,
            borderRadius: 8,
            padding: "1rem",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 13,
              color: COLOR.muted,
              marginBottom: "0.5rem",
            }}
          >
            <span>
              {bulkProgress.carName} @ {bulkProgress.trackName}
            </span>
            <span>
              {bulkProgress.current} / {bulkProgress.total}
            </span>
          </div>
          <div style={styles.updateProgressTrack}>
            <div
              style={{
                ...styles.updateProgressFill,
                width: `${Math.round((bulkProgress.current / bulkProgress.total) * 100)}%`,
                backgroundColor:
                  bulkProgress.status === "error"
                    ? COLOR.red
                    : bulkProgress.status === "skipped"
                      ? COLOR.yellow
                      : COLOR.green,
              }}
            />
          </div>
        </div>
      )}

      {isDone && (
        <div
          style={{
            marginTop: "1rem",
            padding: "0.6rem 1rem",
            backgroundColor: "#052e16",
            border: `1px solid #166534`,
            borderRadius: 6,
            fontSize: 13,
            color: COLOR.green,
          }}
        >
          Done. {okCount} ok / {skippedCount} skipped / {errorCount} error
          {errorCount !== 1 ? "s" : ""}.
        </div>
      )}

      {bulkLog.length > 0 && (
        <div
          style={{
            marginTop: "1rem",
            backgroundColor: COLOR.surface,
            border: `1px solid ${COLOR.border}`,
            borderRadius: 8,
            overflow: "hidden",
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {bulkLog.map((entry, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "0.5rem",
                padding: "0.5rem 0.75rem",
                borderBottom: `1px solid ${COLOR.border}`,
                fontSize: 12,
              }}
            >
              <span
                style={{
                  color:
                    entry.status === "ok"
                      ? COLOR.green
                      : entry.status === "error"
                        ? COLOR.red
                        : COLOR.yellow,
                  fontWeight: 700,
                  minWidth: 14,
                }}
              >
                {entry.status === "ok" ? "+" : entry.status === "error" ? "!" : "-"}
              </span>
              <span style={{ color: COLOR.text, flex: 1 }}>
                <span style={{ fontWeight: 600 }}>{entry.car}</span>
                {" @ "}
                <span style={{ color: COLOR.muted }}>{entry.track}</span>
                {" — "}
                <span
                  style={{
                    color:
                      entry.status === "error"
                        ? COLOR.red
                        : entry.status === "skipped"
                          ? COLOR.yellow
                          : COLOR.muted,
                  }}
                >
                  {entry.message}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
