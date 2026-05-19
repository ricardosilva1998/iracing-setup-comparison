import { useState } from "react";
import { COLOR } from "../../styles";
import type { ClassGroup, Settings } from "../../types";
import { CarShopCell } from "./CarShopCell";
import { evaluateShopChip, runShopBulkDownload } from "./picker-helpers";

const SHOPS_TO_SHOW = [
  { slug: "grid-and-go", label: "Grid-and-Go" },
  { slug: "hymo", label: "HYMO" },
  { slug: "gosetups", label: "GO Setups" },
  { slug: "majors-garage", label: "Majors Garage" },
  { slug: "p1doks", label: "P1Doks" },
];

interface ProgressState {
  currentIndex: number;
  total: number;
  ok: number;
  skipped: number;
  errors: number;
  log: Array<{ status: "ok" | "skipped" | "error"; car: string; message: string }>;
}

interface Props {
  group: ClassGroup;
  trackName: string;
  settings: Settings;
  overrides: Record<string, string>;
  isCurrentSeason: boolean;
  year: number;
  quarter: number;
}

export function ClassAccordion({
  group,
  trackName,
  settings,
  overrides,
  isCurrentSeason,
  year,
  quarter,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [downloadingShop, setDownloadingShop] = useState<string | null>(null);
  const [progressByShop, setProgressByShop] = useState<Record<string, ProgressState>>({});
  const [logsOpen, setLogsOpen] = useState<Record<string, boolean>>({});

  const shopStates = SHOPS_TO_SHOW.map((s) => ({
    ...s,
    state: evaluateShopChip(s.slug, group.cars, isCurrentSeason),
  }));

  async function runShop(shopSlug: string) {
    const target = shopStates.find((s) => s.slug === shopSlug);
    if (!target || !target.state.enabled) return;
    setDownloadingShop(shopSlug);
    setProgressByShop((prev) => ({
      ...prev,
      [shopSlug]: {
        currentIndex: 0,
        total: target.state.carsWithFiles.length,
        ok: 0,
        skipped: 0,
        errors: 0,
        log: [],
      },
    }));
    await runShopBulkDownload({
      shopSlug,
      cars: target.state.carsWithFiles,
      trackName,
      serverUrl: settings.serverUrl,
      year,
      quarter,
      overrides,
      onProgress: (ev) => {
        setProgressByShop((prev) => {
          const cur = prev[shopSlug] ?? {
            currentIndex: 0,
            total: ev.total,
            ok: 0,
            skipped: 0,
            errors: 0,
            log: [],
          };
          const next = {
            currentIndex: ev.currentIndex,
            total: ev.total,
            ok: cur.ok + (ev.status === "ok" ? 1 : 0),
            skipped: cur.skipped + (ev.status === "skipped" ? 1 : 0),
            errors: cur.errors + (ev.status === "error" ? 1 : 0),
            log: [
              ...cur.log,
              { status: ev.status, car: ev.car.name, message: ev.message },
            ],
          };
          return { ...prev, [shopSlug]: next };
        });
      },
    });
    setDownloadingShop(null);
  }

  return (
    <div
      style={{
        border: `1px solid ${COLOR.border}`,
        borderRadius: 8,
        backgroundColor: COLOR.surface,
        overflow: "hidden",
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          padding: "0.65rem 0.85rem",
          cursor: "pointer",
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <span style={{ fontSize: 12, color: COLOR.muted, width: 12 }}>
          {expanded ? "▾" : "▸"}
        </span>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{group.carClass}</span>
        <span style={{ color: COLOR.muted, fontSize: 12 }}>
          {group.cars.length} {group.cars.length === 1 ? "car" : "cars"}
        </span>
        <div style={{ flex: 1 }} />
        <div
          style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}
          onClick={(e) => e.stopPropagation()}
        >
          {shopStates.map((s) => {
            const prog = progressByShop[s.slug];
            const running = downloadingShop === s.slug;
            const done = prog && !running && prog.currentIndex === prog.total;
            return (
              <button
                key={s.slug}
                onClick={() => runShop(s.slug)}
                disabled={!s.state.enabled || downloadingShop !== null}
                title={
                  s.state.reason === "no-pipeline"
                    ? "No file pipeline for this shop yet"
                    : s.state.reason === "hymo-historical"
                    ? "HYMO doesn't expose historical setups"
                    : s.state.reason === "no-cars"
                    ? `No ${group.carClass} cars from ${s.label} at this track`
                    : undefined
                }
                style={{
                  padding: "0.25rem 0.6rem",
                  fontSize: 11,
                  border: `1px solid ${s.state.enabled ? COLOR.border : "transparent"}`,
                  borderRadius: 999,
                  backgroundColor: s.state.enabled
                    ? running
                      ? "#172554"
                      : done
                      ? "#052e16"
                      : COLOR.bg
                    : "transparent",
                  color: s.state.enabled
                    ? running
                      ? COLOR.accent
                      : done
                      ? COLOR.green
                      : COLOR.text
                    : COLOR.muted,
                  cursor:
                    s.state.enabled && downloadingShop === null
                      ? "pointer"
                      : "not-allowed",
                  opacity: s.state.enabled ? 1 : 0.5,
                }}
              >
                {running
                  ? `${prog?.currentIndex ?? 0} / ${prog?.total ?? 0}`
                  : done
                  ? `Done (${prog?.ok ?? 0})`
                  : `Download all (${s.label})`}
              </button>
            );
          })}
        </div>
      </div>

      {/* Per-shop log sections */}
      {Object.entries(progressByShop).map(([slug, prog]) => {
        const open = logsOpen[slug] ?? false;
        if (prog.log.length === 0 && downloadingShop !== slug) return null;
        return (
          <div
            key={slug}
            style={{
              borderTop: `1px solid ${COLOR.border}`,
              padding: "0.4rem 0.85rem",
              fontSize: 11,
              color: COLOR.muted,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                cursor: "pointer",
              }}
              onClick={() => setLogsOpen((p) => ({ ...p, [slug]: !open }))}
            >
              <span>
                {open ? "▾" : "▸"}{" "}
                {SHOPS_TO_SHOW.find((s) => s.slug === slug)?.label}
              </span>
              <span>{prog.ok} ok</span>
              {prog.skipped > 0 && (
                <span style={{ color: COLOR.yellow }}>{prog.skipped} skipped</span>
              )}
              {prog.errors > 0 && (
                <span style={{ color: COLOR.red }}>{prog.errors} errors</span>
              )}
            </div>
            {open && (
              <div
                style={{ marginTop: "0.35rem", maxHeight: 200, overflowY: "auto" }}
              >
                {prog.log.map((entry, i) => (
                  <div key={i} style={{ paddingLeft: "1rem" }}>
                    <span
                      style={{
                        color:
                          entry.status === "ok"
                            ? COLOR.green
                            : entry.status === "error"
                            ? COLOR.red
                            : COLOR.yellow,
                        fontWeight: 700,
                      }}
                    >
                      {entry.status === "ok" ? "+" : entry.status === "error" ? "!" : "-"}
                    </span>{" "}
                    {entry.car} — {entry.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Expanded car list */}
      {expanded &&
        group.cars.map((car) => <CarShopCell key={car.id} car={car} />)}
    </div>
  );
}
