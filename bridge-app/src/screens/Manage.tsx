import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { COLOR, styles } from "../styles";
import { browseRelativeFolder, defaultFolderForCar } from "../helpers";
import type { Settings, Car } from "../types";

const CLASS_ORDER = [
  "GT3", "GT4", "GTE", "GT2", "GTP/LMDh", "LMP2", "LMP3",
  "TCR", "PCUP", "PCC", "Formula", "Production", "NASCAR Cup", "Oval",
];

function sortClasses(classes: string[]): string[] {
  return [...classes].sort((a, b) => {
    const ai = CLASS_ORDER.indexOf(a);
    const bi = CLASS_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
}

interface Props {
  settings: Settings;
  overrides: Record<string, string>;
  onOverridesChanged: () => void;
}

export function ManageScreen({ settings, overrides, onOverridesChanged }: Props) {
  const [allCars, setAllCars] = useState<Car[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const [savingCar, setSavingCar] = useState<string | null>(null);
  const [rowStatus, setRowStatus] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [accordionOpen, setAccordionOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    invoke<{ cars: Car[] }>("fetch_picker", { endpoint: "all-cars" })
      .then((data) => setAllCars(data.cars))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  function getDisplayValue(car: Car): string {
    // Priority: local dirty edit > persisted override > default (with Garage 61 suffix) > empty
    return dirty[car.name] ?? overrides[car.name] ?? defaultFolderForCar(car.iracingFolderName);
  }

  function handleChange(carName: string, value: string) {
    setDirty((prev) => ({ ...prev, [carName]: value }));
    setRowStatus((prev) => {
      const next = { ...prev };
      delete next[carName];
      return next;
    });
  }

  function clearRowStatus(carName: string) {
    setTimeout(() => {
      setRowStatus((prev) => {
        const next = { ...prev };
        delete next[carName];
        return next;
      });
    }, 3000);
  }

  async function handleSaveRow(car: Car) {
    const value = dirty[car.name] ?? overrides[car.name] ?? defaultFolderForCar(car.iracingFolderName);
    if (!value.trim()) {
      setRowStatus((prev) => ({
        ...prev,
        [car.name]: { ok: false, message: "Enter a folder name first." },
      }));
      return;
    }
    setSavingCar(car.name);
    try {
      await invoke("save_car_folder_override", { carName: car.name, folder: value.trim() });
      onOverridesChanged();
      setDirty((prev) => {
        const next = { ...prev };
        delete next[car.name];
        return next;
      });
      setRowStatus((prev) => ({ ...prev, [car.name]: { ok: true, message: "Saved" } }));
      clearRowStatus(car.name);
    } catch (e) {
      setRowStatus((prev) => ({
        ...prev,
        [car.name]: { ok: false, message: String(e) },
      }));
    } finally {
      setSavingCar(null);
    }
  }

  async function handleResetRow(car: Car) {
    setSavingCar(car.name);
    try {
      await invoke("clear_car_folder_override", { carName: car.name });
      onOverridesChanged();
      setDirty((prev) => {
        const next = { ...prev };
        delete next[car.name];
        return next;
      });
      setRowStatus((prev) => ({
        ...prev,
        [car.name]: { ok: true, message: "Reset to default" },
      }));
      clearRowStatus(car.name);
    } catch (e) {
      setRowStatus((prev) => ({
        ...prev,
        [car.name]: { ok: false, message: String(e) },
      }));
    } finally {
      setSavingCar(null);
    }
  }

  async function handleBrowseRow(car: Car) {
    const result = await browseRelativeFolder(
      settings.iracingRoot,
      settings.iracingRoot || undefined,
    );
    if (!result) return;
    if (result.folder) handleChange(car.name, result.folder);
    if (result.error) {
      setRowStatus((prev) => ({ ...prev, [car.name]: { ok: false, message: result.error! } }));
    }
  }

  async function handleSaveAll() {
    const toSave = Object.entries(dirty).filter(([, v]) => v.trim());
    if (toSave.length === 0) return;
    setBulkSaving(true);
    const errors: string[] = [];
    for (const [carName, folder] of toSave) {
      try {
        await invoke("save_car_folder_override", { carName, folder: folder.trim() });
      } catch (e) {
        errors.push(`${carName}: ${String(e)}`);
      }
    }
    onOverridesChanged();
    setDirty({});
    setBulkSaving(false);
    if (errors.length > 0) {
      setError(`Some saves failed:\n${errors.join("\n")}`);
    }
  }

  function toggleAccordion(cls: string) {
    setAccordionOpen((prev) => ({ ...prev, [cls]: !prev[cls] }));
  }

  const lowerSearch = search.toLowerCase();

  // Group all cars by carClass
  const grouped = new Map<string, Car[]>();
  for (const car of allCars) {
    const cls = car.carClass ?? "Unknown";
    if (!grouped.has(cls)) grouped.set(cls, []);
    grouped.get(cls)!.push(car);
  }

  const sortedClasses = sortClasses(Array.from(grouped.keys()));

  // When search is active, a class is visible only if it has matching cars
  const isSearching = lowerSearch.length > 0;

  const dirtyCount = Object.keys(dirty).length;

  function renderCarRow(car: Car) {
    const value = getDisplayValue(car);
    const isBusy = savingCar === car.name;
    const hasOverride = overrides[car.name] !== undefined;
    const hasDirty = dirty[car.name] !== undefined;
    const status = rowStatus[car.name];

    return (
      <div
        key={car.id}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "0.75rem",
          padding: "0.65rem 1rem",
          borderBottom: `1px solid ${COLOR.border}`,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 180, flex: "1 1 180px" }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{car.name}</div>
        </div>

        <div
          style={{
            display: "flex",
            gap: "0.4rem",
            alignItems: "center",
            flex: "2 1 240px",
            flexWrap: "wrap",
          }}
        >
          <input
            style={{
              ...styles.input,
              flex: 1,
              fontSize: 13,
              padding: "0.35rem 0.6rem",
              minWidth: 160,
              borderColor: hasDirty ? COLOR.accent : undefined,
            }}
            type="text"
            value={value}
            onChange={(e) => handleChange(car.name, e.target.value)}
            placeholder="e.g. porsche9922cup/Garage 61 - #NAOTRAVO"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            disabled={isBusy}
          />
          <button
            style={{ ...styles.browseButton, padding: "0.35rem 0.6rem", fontSize: 12 }}
            type="button"
            onClick={() => handleBrowseRow(car)}
            disabled={isBusy}
          >
            Browse…
          </button>
        </div>

        <div
          style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexShrink: 0 }}
        >
          <button
            style={{
              backgroundColor: isBusy ? "#374151" : COLOR.accent,
              color: isBusy ? COLOR.muted : "#fff",
              border: "none",
              borderRadius: 5,
              padding: "0.35rem 0.75rem",
              fontSize: 12,
              fontWeight: 600,
              cursor: isBusy ? "wait" : "pointer",
            }}
            onClick={() => handleSaveRow(car)}
            disabled={isBusy}
          >
            {isBusy ? "…" : "Save"}
          </button>
          {hasOverride && (
            <button
              style={{
                backgroundColor: "transparent",
                color: COLOR.muted,
                border: `1px solid ${COLOR.border}`,
                borderRadius: 5,
                padding: "0.35rem 0.6rem",
                fontSize: 12,
                cursor: isBusy ? "wait" : "pointer",
              }}
              onClick={() => handleResetRow(car)}
              disabled={isBusy}
              title="Clear override and revert to API default"
            >
              Reset
            </button>
          )}
        </div>

        {status && (
          <div
            style={{
              width: "100%",
              fontSize: 11,
              color: status.ok ? COLOR.green : COLOR.red,
            }}
          >
            {status.ok ? "" : "Error: "}
            {status.message}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={styles.screen}>
      {error && (
        <div style={styles.errorBanner} role="alert">
          <span style={{ flex: 1, whiteSpace: "pre-wrap" }}>{error}</span>
          <button
            onClick={() => setError(null)}
            style={styles.errorClose}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      <h1 style={styles.heading}>Manage Folders</h1>
      <p style={styles.subtext}>
        Map each car to its iRacing setup folder. Defaults come from the server's known mapping;
        overrides persist locally and are used by Bulk Download.
      </p>

      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          marginBottom: "1rem",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <input
          style={{ ...styles.input, flex: 1, minWidth: 200 }}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter cars…"
          spellCheck={false}
        />
        {dirtyCount > 0 && (
          <button
            style={bulkSaving ? styles.buttonDisabled : { ...styles.button, marginTop: 0 }}
            onClick={handleSaveAll}
            disabled={bulkSaving}
          >
            {bulkSaving ? "Saving…" : `Save All Edits (${dirtyCount})`}
          </button>
        )}
      </div>

      {loading && <div style={styles.loadingText}>Loading cars…</div>}

      {!loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {sortedClasses.map((cls) => {
            const carsInClass = grouped.get(cls) ?? [];
            const matchingCars = isSearching
              ? carsInClass.filter((c) => c.name.toLowerCase().includes(lowerSearch))
              : carsInClass;

            if (isSearching && matchingCars.length === 0) return null;

            // Auto-expand when searching and there are matches
            const isOpen = isSearching ? true : (accordionOpen[cls] ?? false);

            return (
              <div
                key={cls}
                style={{
                  backgroundColor: COLOR.surface,
                  border: `1px solid ${COLOR.border}`,
                  borderRadius: 8,
                  overflow: "hidden",
                }}
              >
                <button
                  type="button"
                  onClick={() => toggleAccordion(cls)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    padding: "0.65rem 1rem",
                    backgroundColor: "transparent",
                    border: "none",
                    cursor: "pointer",
                    color: COLOR.text,
                    textAlign: "left",
                  }}
                  aria-expanded={isOpen}
                >
                  <span style={{ fontSize: 11, color: COLOR.muted, minWidth: 10 }}>
                    {isOpen ? "▼" : "▶"}
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{cls}</span>
                  <span style={{ fontSize: 12, color: COLOR.muted }}>
                    ({matchingCars.length}{isSearching && matchingCars.length !== carsInClass.length ? ` of ${carsInClass.length}` : ""})
                  </span>
                </button>

                {isOpen && (
                  <div style={{ borderTop: `1px solid ${COLOR.border}` }}>
                    {matchingCars.length === 0 ? (
                      <div style={{ padding: "1rem", color: COLOR.muted, fontSize: 13 }}>
                        No cars match "{search}".
                      </div>
                    ) : (
                      matchingCars.map((car) => renderCarRow(car))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
