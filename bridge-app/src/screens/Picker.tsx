import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { COLOR, styles } from "../styles";
import { slugify, browseRelativeFolder, defaultFolderForCar } from "../helpers";
import type { Settings, Week, Track, Car, ShopFiles } from "../types";

interface Props {
  settings: Settings;
  overrides: Record<string, string>;
  onOverridesChanged: () => void;
}

export function PickerScreen({ settings, overrides, onOverridesChanged }: Props) {
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [cars, setCars] = useState<Car[]>([]);
  const [files, setFiles] = useState<ShopFiles[] | null>(null);

  const [weekNum, setWeekNum] = useState<number | null>(null);
  const [trackId, setTrackId] = useState<number | null>(null);
  const [carId, setCarId] = useState<number | null>(null);

  const [loadingFiles, setLoadingFiles] = useState(false);
  const [downloadStates, setDownloadStates] = useState<
    Record<string, "idle" | "downloading" | "done" | "error">
  >({});
  const [downloadMessages, setDownloadMessages] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [currentIracingFolder, setCurrentIracingFolder] = useState<string>("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [folderFromApi, setFolderFromApi] = useState<string | null>(null);
  const [folderSavedMessage, setFolderSavedMessage] = useState<string | null>(null);

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
          // Tracks with setups first; within that group sort by setupCount
          // descending (most setups → fewest). Zero-count tracks at the end
          // sorted alphabetically. Tiebreaker for equal counts: name.
          if (bc > 0 && ac === 0) return 1;
          if (ac > 0 && bc === 0) return -1;
          if (bc !== ac) return bc - ac;
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
    invoke<{ files: ShopFiles[]; iracingFolderName: string | null }>("fetch_picker", {
      endpoint: `files?weekNum=${weekNum}&trackId=${trackId}&carId=${carId}`,
    })
      .then((data) => {
        setFiles(data.files);
        setDownloadStates({});
        setDownloadMessages({});
        setFolderFromApi(data.iracingFolderName);
        setFolderSavedMessage(null);
        setFolderError(null);
        // Priority: persisted override > default (iracingFolderName/Garage 61 suffix) > empty
        const car = cars.find((c) => c.id === carId);
        const override = car ? overrides[car.name] : undefined;
        setCurrentIracingFolder(override ?? defaultFolderForCar(data.iracingFolderName));
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoadingFiles(false));
    // overrides intentionally omitted — re-apply happens in the effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekNum, trackId, carId]);

  // Re-apply override when the overrides map refreshes (e.g. after save from Manage screen).
  useEffect(() => {
    if (carId === null) return;
    const car = cars.find((c) => c.id === carId);
    if (!car) return;
    const override = overrides[car.name];
    if (override !== undefined) {
      setCurrentIracingFolder(override);
    }
  }, [overrides, carId, cars]);

  async function handleBrowseFolder() {
    const result = await browseRelativeFolder(
      settings.iracingRoot,
      settings.iracingRoot || undefined,
    );
    if (!result) return;
    if (result.error === "Pick a subfolder of the iRacing setups root, not the root itself.") {
      setFolderError(result.error);
      return;
    }
    setCurrentIracingFolder(result.folder);
    setFolderError(result.error);
  }

  async function handleSaveCarFolder() {
    const selectedCar = cars.find((c) => c.id === carId);
    if (!selectedCar || !currentIracingFolder.trim()) {
      setFolderError("Pick a car and enter a folder first.");
      return;
    }
    try {
      await invoke("save_car_folder_override", {
        carName: selectedCar.name,
        folder: currentIracingFolder.trim(),
      });
      onOverridesChanged();
      setFolderSavedMessage(`Saved override for ${selectedCar.name}`);
      setTimeout(() => setFolderSavedMessage(null), 3000);
      setFolderError(null);
    } catch (e) {
      setFolderError(`Save failed: ${String(e)}`);
    }
  }

  async function handleDownload(shopFile: ShopFiles, carName: string, trackName: string) {
    let assetUrl: string | null = null;
    let resolvedDatapackId = "";
    if (shopFile.shopSlug === "grid-and-go" && shopFile.datapackId) {
      resolvedDatapackId = shopFile.datapackId;
      assetUrl = null;
    } else if (shopFile.shopSlug === "hymo" && shopFile.externalId) {
      assetUrl = `${settings.serverUrl}/api/files/hymo/${shopFile.externalId}/zip`;
    } else {
      return;
    }
    const trimmedFolder = currentIracingFolder.trim();
    if (!trimmedFolder) {
      setFolderError("Enter iRacing folder first");
      return;
    }
    setFolderError(null);
    const key = shopFile.shopSlug;
    setDownloadStates((prev) => ({ ...prev, [key]: "downloading" }));
    try {
      const result = await invoke<{ savedTo: string; fileNames: string[] }>("download_setups", {
        args: {
          carSlug: slugify(carName),
          seasonLabel: "26s2",
          trackSlug: slugify(trackName),
          shopSlug: shopFile.shopSlug,
          datapackId: resolvedDatapackId,
          iracingFolderName: trimmedFolder || null,
          carName,
          assetUrl,
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
          <div style={styles.folderRow}>
            <label style={styles.folderLabel} htmlFor="iracing-folder-input">
              iRacing folder
            </label>
            <div style={styles.inputRow}>
              <input
                id="iracing-folder-input"
                style={
                  folderError
                    ? { ...styles.input, borderColor: COLOR.red, flex: 1 }
                    : { ...styles.input, flex: 1 }
                }
                type="text"
                value={currentIracingFolder}
                onChange={(e) => {
                  setCurrentIracingFolder(e.target.value);
                  if (e.target.value.trim()) setFolderError(null);
                }}
                placeholder="e.g. porsche9922cup"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
              />
              <button style={styles.browseButton} type="button" onClick={handleBrowseFolder}>
                Browse…
              </button>
              <button
                style={{
                  ...styles.browseButton,
                  backgroundColor: "#052e16",
                  borderColor: "#166534",
                  color: COLOR.green,
                }}
                type="button"
                onClick={handleSaveCarFolder}
                title="Persist this folder for the selected car so bulk download can use it"
              >
                Save for this car
              </button>
            </div>
            {folderError && <span style={styles.folderErrorText}>{folderError}</span>}
            {folderSavedMessage && (
              <span style={{ fontSize: 12, color: COLOR.green }}>{folderSavedMessage}</span>
            )}
            {folderFromApi === null && !folderError && !folderSavedMessage && (
              <div style={styles.folderWarning}>
                No iRacing folder mapping for this car — please enter one manually before downloading.
              </div>
            )}
            <p style={styles.folderHint}>
              Files will be saved to &lt;root&gt;/{currentIracingFolder || "…"}/&lt;season&gt;/&lt;track&gt;/&lt;shop&gt;/.
            </p>
          </div>
          <h2 style={styles.filesHeading}>Available Files</h2>
          {files.map((sf) => {
            const dlState = downloadStates[sf.shopSlug] ?? "idle";
            const dlMsg = downloadMessages[sf.shopSlug];
            return (
              <div key={sf.shopSlug} style={styles.shopRow}>
                <div style={styles.shopInfo}>
                  <span style={styles.shopName}>{sf.shopName}</span>
                  <span style={styles.fileCount}>
                    {sf.datapackId || sf.externalId
                      ? sf.fileNames.length > 0
                        ? `${sf.fileNames.length} files cached`
                        : "ready to download"
                      : "no auto-download"}
                  </span>
                </div>
                {((sf.shopSlug === "grid-and-go" && sf.datapackId) ||
                  (sf.shopSlug === "hymo" && sf.externalId)) &&
                  selectedCar &&
                  selectedTrack && (
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
                      <span style={dlState === "error" ? styles.dlMsgError : styles.dlMsgOk}>
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
      </div>
    </div>
  );
}
