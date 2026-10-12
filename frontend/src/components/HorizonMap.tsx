import ExportDialog from "./ExportDialog";
import { Layers, MousePointer2, Move, Plus, RotateCcw, ScanLine, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import type { HorizonMapState, MapWorkspace } from "../workspace";
import { reconcileMapWorkspace } from "../workspace";
import { mapPresentation, mapSelectionError, profileEndpointError, profileRequestKey } from "./horizonMapLogic";
import { createPortal } from "react-dom";
import Plotly from "plotly.js-dist-min";
import type { HS } from "../types";
import type { ExportDialogSettings, SS } from "../types";
import { api } from "../api/client";
import { formatAmplitude } from "../format";
import { Group, Num, Toggle, SubsectionSummary, Select } from "./Controls";
import ColormapSelect, { colormapOptions } from "./ColormapSelect";

type State = HorizonMapState;
type ProfileCurve = { id: string; name: string; values: (number | null)[] };
type ProfileData = {
  distance: number[];
  time: number[];
  /** Time-major heatmap rows: amplitude[time][position]. */
  amplitude: (number | null)[][];
  curves: ProfileCurve[];
  a_distance: number;
  b_distance: number;
  path_start: [number, number];
  path_end: [number, number];
  vmin: number;
  vmax: number;
  label_y: string;
};
type DifferenceStats = {
  mae: number | null;
  rmse: number | null;
  bias: number | null;
  valid_ratio: number;
  count: number;
};
type Data = {
  x: number[];
  y: number[];
  z: (number | null)[][];
  colorbar_title?: string;
  scalar_name?: string;
  scalar_unit?: string;
  twt_range: number[];
  vmin: number;
  vmax: number;
  colorscale: any[];
  contours: { level: number; x: number[]; y: number[] }[];
  statistics?: DifferenceStats;
};
export default function HorizonMap({
  controlsHost,
  workspace,
  onWorkspace,
  horizons,
  maps,
  mapColors,
  seismic,
  aspect,
  onSeismic,
  onAspect,
  onAddProfileToExport,
  exportOpen,
  onCloseExport,
  onReady,
  dataset,
  datasetPlaceholder,
  onDataset,
  onAddToExport,
}: {
  controlsHost: HTMLDivElement | null;
  workspace: MapWorkspace;
  onWorkspace: Dispatch<SetStateAction<MapWorkspace>>;
  horizons: HS[];
  maps: Record<string, any[]>;
  mapColors: Record<string, any[]>;
  /** Shared with the 2D window: the profile reuses its display settings. */
  seismic: SS;
  aspect: [number, number] | null;
  onSeismic: (patch: Partial<SS>) => void;
  onAspect: (ratio: [number, number] | null) => void;
  /** Queue the standalone A–B profile figure (payload built here). */
  onAddProfileToExport: (payload: {
    state: State;
    a: [number, number];
    b: [number, number];
    curve_colors: Record<string, string>;
    colormap: string;
    reverse_colormap: boolean;
    settings: Record<string, unknown>;
  }) => Promise<void>;
  exportOpen: boolean;
  onCloseExport: () => void;
  onReady: (v: boolean) => void;
  dataset: string;
  datasetPlaceholder?: string;
  onDataset: (value: string) => void;
  onAddToExport: (payload: { state: State; settings: Record<string, unknown> }) => Promise<void>;
}) {
  const { state: savedState, settings, drag, profileOn, profileA, profileB, profileSettings } = workspace;
  // Display mode controls contour visibility, including for older saved workspaces.
  const state = { ...savedState, contours: savedState.display !== "filled" };
  const profileShare = Math.min(70, Math.max(30, workspace.profileShare ?? 45));
  const presentation = mapPresentation(state, horizons);
  const horizonKey = JSON.stringify(horizons.map(h => [h.id, h.name]));
  const mapIssue = mapSelectionError(state, horizons);
  const query = JSON.stringify({
    ...state,
    interval: state.interval_auto ? null : state.interval,
    x_range: null,
    y_range: null,
  });
  const mapQueryKey = JSON.stringify({ query, horizonKey });
  function update<K extends keyof MapWorkspace>(key: K, value: SetStateAction<MapWorkspace[K]>) {
    onWorkspace(previous => ({ ...previous, [key]: typeof value === "function"
      ? (value as (value: MapWorkspace[K]) => MapWorkspace[K])(previous[key]) : value }));
  }
  const setState = (value: SetStateAction<State>) => update("state", value);
  const setSettings = (value: SetStateAction<ExportDialogSettings>) => update("settings", value);
  const setDrag = (value: "zoom" | "pan") => update("drag", value);
  const setProfileOn = (value: boolean) => update("profileOn", value);
  const setProfileA = (value: [number, number] | null) => update("profileA", value);
  const setProfileB = (value: [number, number] | null) => update("profileB", value);
  const setProfileSettings = (value: SetStateAction<ExportDialogSettings>) => update("profileSettings", value);
  const [mapResult, setMapResult] = useState<{ key: string; data: Data } | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false);
  const data = !mapIssue && mapResult?.key === mapQueryKey ? mapResult.data : null;
  const plot = useRef<HTMLDivElement>(null),
    queue = useRef(Promise.resolve()),
    version = useRef(0),
    latest = useRef(state);
  latest.current = state;
  const [picking, setPicking] = useState<null | "a" | "b">(null);
  const [profileResult, setProfileResult] = useState<{ key: string; data: ProfileData } | null>(null);
  const [profileFailure, setProfileFailure] = useState<{ key: string; message: string } | null>(null);
  const [profileExportOpen, setProfileExportOpen] = useState(false);
  const [profileExportBusy, setProfileExportBusy] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const patch = (p: Partial<State>) => setState((s) => ({ ...s, ...p }));
  const centerInline = Math.round(((data?.y[0] ?? 0) + (data?.y.at(-1) ?? 0)) / 2);
  const centerCrossline = Math.round(((data?.x[0] ?? 0) + (data?.x.at(-1) ?? 0)) / 2);
  const setPoint = (
    setter: (p: [number, number] | null) => void,
    point: [number, number] | null,
    index: 0 | 1,
    value: number,
  ) => {
    const base: [number, number] = point ?? [centerInline, centerCrossline];
    const next = [...base] as [number, number];
    next[index] = value;
    setter(next);
  };
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    onWorkspace(current => reconcileMapWorkspace(current, horizons));
  }, [horizons, state.horizon, state.difference_reference, state.difference_comparison]);
  const profileQueryKey = profileRequestKey(state, horizonKey, profileA, profileB, seismic);
  const endpointError = profileEndpointError(profileA, profileB);
  const profileData = !endpointError && !mapIssue && profileResult?.key === profileQueryKey ? profileResult.data : null;
  const profileError = endpointError || (profileFailure?.key === profileQueryKey ? profileFailure.message : "");
  const profilePending = profileOn && !!profileA && !!profileB && !profileError && !mapIssue && !profileData;
  const setProfileError = (message: string) => setProfileFailure(message ? { key: profileQueryKey, message } : null);
  const clearProfile = () => {
    setProfileA(null);
    setProfileB(null);
    setPicking(null);
    setProfileResult(null);
    setProfileError("");
  };
  useEffect(() => {
    if (!picking) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector('[aria-modal="true"]')) setPicking(null);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [picking]);
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    version.current++;
    ready.current(false);
    setMapResult(null);
    setError("");
    setLoading(!!state.horizon && !mapIssue);
    if (mapIssue) return;
    const timer = setTimeout(async () => {
      try {
        const res = await api(
          "/horizon-map",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: query,
            signal: abort.signal,
          },
          "请检查色彩范围与等值线间隔。",
        );
        const result = await res.json();
        if (active) {
          setMapResult({ key: mapQueryKey, data: result });
          setError("");
        }
      } catch (e) {
        if (active && (e as Error).name !== "AbortError")
          setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    }, 160);
    return () => {
      active = false;
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, horizonKey, mapIssue]);
  useEffect(() => {
    const el = plot.current as any;
    if (!el || !data) {
      version.current++;
      ready.current(false);
      return;
    }
    const token = ++version.current;
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        if (token !== version.current) return;
        el.removeAllListeners?.("plotly_relayout");
        el.removeAllListeners?.("plotly_click");
        const scalarHover = (value: string) => `${presentation.scalar}: %{${value}:.2f}${presentation.unit ? ` ${presentation.unit}` : ""}`;
        const traces: any[] = [];
        if (state.display !== "contour")
          traces.push({
            type: "heatmap",
            x: data.x,
            y: data.y,
            z: data.z,
            zmin: data.vmin,
            zmax: data.vmax,
            colorscale: data.colorscale,
            showscale: state.colorbar,
            colorbar: { title: { text: data.colorbar_title || "TWT (ms)" } },
            zsmooth: false,
            connectgaps: false,
            hoverongaps: false,
            hovertemplate:
              `Inline: %{y}<br>Crossline: %{x}<br>${scalarHover("z")}<extra></extra>`,
          });
        else
          traces.push({
            type: "scatter",
            x: [null],
            y: [null],
            mode: "markers",
            marker: {
              color: [data.vmin],
              cmin: data.vmin,
              cmax: data.vmax,
              colorscale: data.colorscale,
              showscale: state.colorbar,
              colorbar: { title: { text: data.colorbar_title || "TWT (ms)" } },
            },
            hoverinfo: "skip",
          });
        const cx: (number | null)[] = [],
          cy: (number | null)[] = [],
          values: (number | null)[] = [];
        const lx: number[] = [],
          ly: number[] = [],
          labels: string[] = [];
        for (const line of data.contours) {
          for (let j = 0; j < line.x.length; j++) {
            cx.push(line.x[j]);
            cy.push(line.y[j]);
            values.push(line.level);
          }
          cx.push(null);
          cy.push(null);
          values.push(null);
          if (line.x.length > 2) {
            const i = Math.floor(line.x.length / 2);
            lx.push(line.x[i]);
            ly.push(line.y[i]);
            labels.push(String(line.level));
          }
        }
        traces.push({
          type: "scatter",
          mode: "lines",
          x: cx,
          y: cy,
          customdata: values,
          line: { color: "#333333", width: (state.line_width * 4) / 3 },
          connectgaps: false,
          hovertemplate:
            `Inline: %{y}<br>Crossline: %{x}<br>${scalarHover("customdata")}<extra></extra>`,
        });
        if (state.labels)
          traces.push({
            type: "scatter",
            mode: "text",
            x: lx,
            y: ly,
            text: labels,
            textfont: { size: 11, color: "#333" },
            hoverinfo: "skip",
          });
        if (profileOn && profileA && profileB) {
          // The section covers the path beyond A/B as well: draw the extended
          // reaches as a finer dotted line so map and profile agree. Black
          // stays visible on every colormap (same choice as the contours).
          if (profileData) {
            for (const [from, to] of [
              [profileData.path_start, profileA],
              [profileB, profileData.path_end],
            ]) {
              traces.push({
                type: "scatter",
                mode: "lines",
                x: [from[1], to[1]],
                y: [from[0], to[0]],
                line: { color: "#1a1a1a", width: 1.5, dash: "dot" },
                connectgaps: true,
                hoverinfo: "skip",
                showlegend: false,
              });
            }
          }
          traces.push({
            type: "scatter",
            mode: "lines+markers",
            x: [profileA[1], profileB[1]],
            y: [profileA[0], profileB[0]],
            line: { color: "#1a1a1a", width: 2, dash: "dash" },
            marker: { color: "#1a1a1a", size: 7 },
            connectgaps: true,
            hoverinfo: "skip",
            showlegend: false,
          });
        }
        const abAnnotations =
          profileOn && profileA && profileB
            ? [
                { x: profileA[1], y: profileA[0], text: "A" },
                { x: profileB[1], y: profileB[0], text: "B" },
              ].map(({ x, y, text }) => ({
                x,
                y,
                text,
                showarrow: false,
                xanchor: "left",
                yanchor: "top",
                xshift: 4,
                yshift: 4,
                font: { size: 11, color: "#1a1a1a" },
                bgcolor: "rgba(255, 255, 255, 0.85)",
                bordercolor: "#1a1a1a",
                borderwidth: 1,
                borderpad: 1,
              }))
            : [];
        await Plotly.react(
          el,
          traces,
          {
            margin: { l: 70, r: 100, t: 30, b: 60 },
            showlegend: false,
            dragmode: drag,
            paper_bgcolor: "#fff",
            plot_bgcolor: "#fff",
            font: { family: "DM Sans, 'PingFang SC', Arial, sans-serif", color: "#425367", size: 11 },
            xaxis: {
              title: { text: "Crossline" },
              range: state.x_range || [data.x[0] - 0.5, data.x.at(-1)! + 0.5],
              constrain: "domain",
              showgrid: false,
            },
            yaxis: {
              title: { text: "Inline" },
              range: state.y_range || [data.y[0] - 0.5, data.y.at(-1)! + 0.5],
              scaleanchor: "x",
              scaleratio: 1,
              constrain: "domain",
              showgrid: false,
            },
          } as any,
          { responsive: true, scrollZoom: true, displayModeBar: false },
        );
        if (token !== version.current) return;
        // Profile picking: the next map click lands on A, the one after on B.
        el.on("plotly_click", (event: any) => {
          const target = pickingRef.current;
          const point = event?.points?.[0];
          if (!target || !point) return;
          const pos: [number, number] = [point.y, point.x];
          if (target === "a") {
            setProfileA(pos);
            setPicking("b");
          } else {
            setProfileB(pos);
            setPicking(null);
          }
        });
        el.on("plotly_relayout", (e: any) => {
          if (e["xaxis.autorange"] || e["yaxis.autorange"])
            patch({ x_range: null, y_range: null });
          else if (
            e["xaxis.range[0]"] !== undefined ||
            e["yaxis.range[0]"] !== undefined
          )
            patch({
              x_range:
                e["xaxis.range[0]"] !== undefined
                  ? [e["xaxis.range[0]"], e["xaxis.range[1]"]]
                  : latest.current.x_range,
              y_range:
                e["yaxis.range[0]"] !== undefined
                  ? [e["yaxis.range[0]"], e["yaxis.range[1]"]]
                  : latest.current.y_range,
            });
        });
        ready.current(true);
      })
      .catch((e) => {
        setError(String(e));
        ready.current(false);
      });
  }, [data, state.x_range, state.y_range, drag, profileOn, profileA, profileB, profileData, presentation.scalar, presentation.unit]);
  // Map coloring does not change the A–B seismic raster or horizon curves.
  useEffect(() => {
    setProfileResult(null);
    setProfileFailure(null);
    if (!profileOn || !profileA || !profileB || endpointError || mapIssue) return;
    const abort = new AbortController();
    let active = true;
    const timer = setTimeout(async () => {
      try {
        // Same adaptive-resolution contract as the 2D window: ask for the
        // subplot's real pixels; the raster is resampled server-side with the
        // selected filter (and not at all when 自适应分辨率 is off).
        const box = profileRef.current;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const res = await api("/horizon-map/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            state: JSON.parse(query),
            a: profileA,
            b: profileB,
            ...(seismic.adaptive_resolution
              ? {
                  target_width: box ? Math.round(box.clientWidth * ratio) : null,
                  target_height: box ? Math.round(box.clientHeight * ratio) : null,
                }
              : {}),
            interpolation: seismic.interpolation,
          }),
          signal: abort.signal,
        });
        const result = await res.json();
        if (active) setProfileResult({ key: profileQueryKey, data: result });
      } catch (e) {
        if (active && (e as Error).name !== "AbortError")
          setProfileError((e as Error).message);
      }
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
      abort.abort();
    };
  }, [profileOn, profileQueryKey, endpointError, mapIssue]);

  // Profile subplot: interpolated seismic section with horizon TWT overlays.
  useEffect(() => {
    const el = profileRef.current as any;
    if (!el) return;
    // Keep the hidden plot mounted while a new result is pending. Purging it
    // here would discard its measured dimensions and reset Plotly's layout.
    if (!profileData) return;
    // Same colormap the 2D window uses, reversal included.
    const base = maps?.[seismic.colormap]?.length
      ? maps[seismic.colormap]
      : "RdBu";
    const colorscale =
      seismic.reverse_colormap && Array.isArray(base)
        ? base.map((c, i) => [c[0], base[base.length - 1 - i][1]])
        : base;
    const traces: any[] = [
      {
        type: "heatmap",
        x: profileData.distance,
        y: profileData.time,
        z: profileData.amplitude,
        colorscale,
        zmin: profileData.vmin,
        zmax: profileData.vmax,
        showscale: false,
        zsmooth: false,
        hovertemplate: "距离 %{x:.1f}<br>TWT %{y:.1f} ms<br>振幅 %{z}<extra></extra>",
      },
    ];
    for (const curve of profileData.curves) {
      const style = horizons.find((h) => h.id === curve.id);
      if (!style || !style.visible) continue;
      traces.push({
        type: "scatter",
        mode: "lines",
        name: style.name,
        x: profileData.distance,
        y: curve.values,
        connectgaps: false,
        line: { color: style?.color || "#e6b450", width: 2.5 },
        hovertemplate: `${style.name}<br>TWT %{y:.1f} ms<extra></extra>`,
      });
    }
    // Aspect lock shared with the 2D window: the same 横向/纵向 ratio.
    const distSpan = Math.abs(
      (profileData.distance.at(-1) ?? 1) - (profileData.distance[0] ?? 0),
    );
    const timeSpan = Math.abs(
      (profileData.time.at(-1) ?? 1) - (profileData.time[0] ?? 0),
    );
    const abShape = (x: number) => ({
      type: "line",
      x0: x,
      x1: x,
      yref: "paper",
      y0: 0,
      y1: 1,
      line: { color: "#365985", width: 1.5, dash: "dot" },
    });
    const abLabel = (x: number, text: string) => ({
      x,
      yref: "paper",
      y: 1.03,
      text,
      showarrow: false,
      font: { color: "#365985", size: 11 },
    });
    Plotly.react(
      el,
      traces,
      {
        margin: { l: 62, r: 14, t: 20, b: 38 },
        showlegend: false,
        paper_bgcolor: "#fff",
        plot_bgcolor: "#fff",
        font: { family: "DM Sans, 'PingFang SC', Arial, sans-serif", color: "#425367", size: 11 },
        xaxis: { title: { text: "距离 (网格)", standoff: 8 }, showgrid: false, linecolor: "#bcc8cf", ticks: "outside" },
        yaxis: {
          title: { text: profileData.label_y, standoff: 4 },
          range: [profileData.time.at(-1) ?? 0, profileData.time[0] ?? 0],
          autorange: false,
          scaleanchor: aspect ? "x" : undefined,
          scaleratio: aspect
            ? (aspect[1] / aspect[0]) * (distSpan / timeSpan)
            : undefined,
          constrain: "domain",
          showgrid: false,
          linecolor: "#bcc8cf",
          ticks: "outside",
        },
        hovermode: "closest",
        shapes: [
          abShape(profileData.a_distance),
          abShape(profileData.b_distance),
        ],
        annotations: [
          abLabel(profileData.a_distance, "A"),
          abLabel(profileData.b_distance, "B"),
        ],
      } as any,
      { responsive: true, displayModeBar: false, scrollZoom: true },
    );
  }, [profileData, maps, horizons, seismic, aspect]);

  useEffect(() => {
    if (!profileOn) return;
    const el = profileRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if ((el as any).data && el.clientWidth && el.clientHeight) {
        Plotly.relayout(el, { width: el.clientWidth, height: el.clientHeight });
      }
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      Plotly.purge(el);
    };
  }, [profileOn]);

  useEffect(() => {
    const el = plot.current!;
    const observer = new ResizeObserver(() => {
      if ((el as any).data && el.clientWidth && el.clientHeight) {
        Plotly.relayout(el, { width: el.clientWidth, height: el.clientHeight });
      }
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      version.current++;
      queue.current.finally(() => Plotly.purge(el));
      ready.current(false);
    };
  }, []);
  async function addToExport() {
    if (!data || loading || mapIssue) return;
    setSaving(true);
    try {
      await onAddToExport({ state, settings });
      setError("");
      onCloseExport();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const select = (
    label: string,
    value: string,
    options: [string, string][],
    change: (s: string) => void,
  ) => (
    <label className="field">
      {label}
      <Select aria-label={label} value={value} onChange={(e) => change(e.target.value)}>
        {!options.some(([id]) => id === value) && <option value="" disabled>请选择{label}</option>}
        {options.map(([v, l]) => (
          <option key={v} value={v} disabled={label === "颜色变量" && v === "difference" && horizons.length < 2}>
            {l}
          </option>
        ))}
      </Select>
    </label>
  );
  const controls = (
    <div className="map-controls">
      <Group icon={<Layers size={16} />} title="层位地图">
        {state.color_by !== "difference" &&
          select(
            "当前层位",
            state.horizon,
            horizons.map((h) => [h.id, h.name]),
            (horizon) =>
              patch({
                horizon,
                range_mode: "auto",
                vmin: null,
                vmax: null,
                x_range: null,
                y_range: null,
              }),
          )}
        {select(
          "颜色变量",
          state.color_by,
          [
            ["twt", "TWT"],
            ["amplitude", "沿层振幅"],
            ["difference", "差值"],
          ],
          (color_by) => {
            const next: Partial<State> = {
              color_by: color_by as State["color_by"],
              range_mode: "auto",
              vmin: null,
              vmax: null,
              interval_auto: true,
            };
            if (color_by === "amplitude") next.colormap = "seismic";
            else if (color_by === "difference") {
              next.colormap = "RdBu";
              next.difference_type = "signed";
              next.difference_reference = latest.current.horizon;
              next.difference_comparison =
                horizons.find((h) => h.id !== latest.current.horizon)?.id ??
                latest.current.horizon;
            } else next.colormap = "petrel";
            patch(next);
          },
        )}
        {state.color_by === "difference" && (
          <>
            <div className="field-row">
              {select(
                "参考层位",
                state.difference_reference ?? "",
                horizons.map((h) => [h.id, h.name]),
                (difference_reference) => patch({ difference_reference }),
              )}
              {select(
                "对比层位",
                state.difference_comparison ?? "",
                horizons.map((h) => [h.id, h.name]),
                (difference_comparison) => patch({ difference_comparison }),
              )}
            </div>
            <label className="map-field-label" title="ΔTWT = 对比层位 − 参考层位">差值类型</label>
            <div
              className="map-display-options"
              role="group"
              aria-label="差值类型"
            >
              {(
                [
                  ["signed", "有符号"],
                  ["absolute", "绝对值"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  className={state.difference_type === value ? "active" : ""}
                  aria-pressed={state.difference_type === value}
                  onClick={() =>
                    patch({
                      difference_type: value,
                      colormap: value === "absolute" ? "viridis" : "RdBu",
                      range_mode: "auto",
                      vmin: null,
                      vmax: null,
                    })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        )}
        {state.color_by === "difference" && (
          <>
            {select(
              "输出网格层位",
              state.horizon,
              horizons.map((h) => [h.id, h.name]),
              (horizon) =>
                patch({
                  horizon,
                  range_mode: "auto",
                  vmin: null,
                  vmax: null,
                  x_range: null,
                  y_range: null,
                }),
            )}
            <Toggle
              label="显示统计"
              checked={state.show_statistics}
              onChange={(show_statistics) => patch({ show_statistics })}
            />
          </>
        )}
        {state.color_by === "difference" &&
          state.show_statistics &&
          data?.statistics && (
            <div className="map-stats" role="status" aria-label="差值统计">
              <span>
                MAE
                <b>
                  {data.statistics.mae === null
                    ? "—"
                    : `${formatAmplitude(data.statistics.mae)} ms`}
                </b>
              </span>
              <span>
                RMSE
                <b>
                  {data.statistics.rmse === null
                    ? "—"
                    : `${formatAmplitude(data.statistics.rmse)} ms`}
                </b>
              </span>
              <span>
                Bias
                <b>
                  {data.statistics.bias === null
                    ? "—"
                    : `${formatAmplitude(data.statistics.bias)} ms`}
                </b>
              </span>
              <span>
                有效率
                <b>{(data.statistics.valid_ratio * 100).toFixed(1)}%</b>
              </span>
            </div>
          )}
        <label className="map-field-label">显示方式</label>
        <div
          className="map-display-options"
          role="group"
          aria-label="地图显示方式"
        >
          {[
            ["filled", "填色"],
            ["contour", "等值线"],
            ["filled_contour", "叠加"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={state.display === value ? "active" : ""}
              aria-pressed={state.display === value}
              onClick={() => patch({ display: value, contours: value !== "filled" })}
            >
              {label}
            </button>
          ))}
        </div>
        <ColormapSelect
          label="地图色标"
          value={state.colormap}
          options={((state.color_by === "amplitude"
            ? [
                ["seismic", "Seismic"],
                ["RdBu", "RdBu"],
                ["coolwarm", "Coolwarm"],
              ]
            : state.color_by === "difference"
              ? state.difference_type === "absolute"
                ? [
                    ["viridis", "Viridis"],
                    ["turbo", "Turbo"],
                    ["magma", "Magma"],
                  ]
                : [
                    ["RdBu", "RdBu"],
                    ["coolwarm", "Coolwarm"],
                    ["seismic", "Seismic"],
                  ]
              : [
                  ["petrel", "Petrel"],
                  ["turbo", "Turbo"],
                  ["viridis", "Viridis"],
                  ["cividis", "Cividis"],
                  ["jet", "Jet"],
                ]) as [string, string][]).map(([value, label]) => ({ value, label, colors: mapColors[value] || [] }))}
          reverse={state.reverse_colormap}
          onChange={(colormap) => patch({ colormap })}
          range={data ? `${data.vmin.toFixed(1)}–${data.vmax.toFixed(1)}${presentation.unit ? ` ${presentation.unit}` : ""}` : undefined}
        />
        <div className="check-row">
          <Toggle
            label="反转色标"
            checked={state.reverse_colormap}
            onChange={(reverse_colormap) => patch({ reverse_colormap })}
          />
          <Toggle
            label="显示色标尺"
            checked={state.colorbar}
            onChange={(colorbar) => patch({ colorbar })}
          />
        </div>
        <div className="map-range-mode">
          <span>颜色范围</span>
          <div
            className="map-display-options"
            role="group"
            aria-label="颜色范围"
          >
            {[
              ["auto", "自动"],
              ["manual", "手动"],
            ].map(([value, label]) => (
              <button
                key={value}
                className={state.range_mode === value ? "active" : ""}
                aria-pressed={state.range_mode === value}
                onClick={() =>
                  patch({
                    range_mode: value,
                    vmin: data?.vmin ?? 0,
                    vmax: data?.vmax ?? 1,
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {state.range_mode === "manual" && (
          <div className="field-row">
            <label>
              最小值{state.color_by === "amplitude" ? "" : " · ms"}
              <Num
                value={state.vmin ?? 0}
                onChange={(vmin) => patch({ vmin })}
              />
            </label>
            <label>
              最大值{state.color_by === "amplitude" ? "" : " · ms"}
              <Num
                value={state.vmax ?? 1}
                onChange={(vmax) => patch({ vmax })}
              />
            </label>
          </div>
        )}
        {state.color_by === "amplitude" && state.range_mode === "auto" && (
          <div className="section-number">
            <span>裁剪百分位 %</span>
            <Num
              value={state.clip_percentile}
              min={0.1}
              max={100}
              step={0.1}
              onChange={(clip_percentile) => patch({ clip_percentile })}
            />
          </div>
        )}
      </Group>
      <Group
        icon={<ScanLine size={16} />}
        title="A–B 剖面"
        defaultOpen={profileOn}
      >
        <Toggle
          label="显示 A–B 剖面"
          checked={profileOn}
          onChange={(value) => {
            setProfileOn(value);
            setPicking(null);
          }}
        />
        {profileOn && (
          <div className="map-profile-controls">
            <div className="field-row">
              <label>
                A · Inline
                <Num
                  label="A 点 Inline"
                  value={profileA?.[0] ?? centerInline}
                  onChange={(v) => setPoint(setProfileA, profileA, 0, v)}
                />
              </label>
              <label>
                A · Crossline
                <Num
                  label="A 点 Crossline"
                  value={profileA?.[1] ?? centerCrossline}
                  onChange={(v) => setPoint(setProfileA, profileA, 1, v)}
                />
              </label>
            </div>
            <div className="field-row">
              <label>
                B · Inline
                <Num
                  label="B 点 Inline"
                  value={profileB?.[0] ?? centerInline}
                  onChange={(v) => setPoint(setProfileB, profileB, 0, v)}
                />
              </label>
              <label>
                B · Crossline
                <Num
                  label="B 点 Crossline"
                  value={profileB?.[1] ?? centerCrossline}
                  onChange={(v) => setPoint(setProfileB, profileB, 1, v)}
                />
              </label>
            </div>
            <details className="subsettings">
              <SubsectionSummary title="剖面显示" />
              <div className="subsettings-body">
                <ColormapSelect label="剖面色标" value={seismic.colormap} options={colormapOptions(maps)} reverse={seismic.reverse_colormap} onChange={(colormap) => onSeismic({ colormap })} />
                <Toggle
                  label="反转剖面色标"
                  checked={seismic.reverse_colormap}
                  onChange={(reverse_colormap) =>
                    onSeismic({ reverse_colormap })
                  }
                />
                <Toggle
                  label="固定横纵比例"
                  checked={!!aspect}
                  onChange={(enabled) => onAspect(enabled ? [2, 1] : null)}
                />
                {aspect && (
                  <div className="field-row">
                    {["横向比例", "纵向比例"].map((label, index) => (
                      <label key={label}>
                        {label}
                        <Num
                          value={aspect[index]}
                          min={0.1}
                          max={5}
                          step={0.1}
                          onChange={(n) => {
                            const ratio = [...aspect] as [number, number];
                            ratio[index] = n;
                            onAspect(ratio);
                          }}
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </details>
          </div>
        )}
      </Group>
      <Group icon={<ScanLine size={16} />} title="等值线" defaultOpen={false}>
        <fieldset
          className="map-contour-fields"
          disabled={state.display === "filled"}
        >
          <label className="field">
            线宽 · pt
            <Num
              label="等值线线宽（pt）"
              value={state.line_width}
              min={0.1}
              max={6}
              step={0.1}
              onChange={(line_width) => patch({ line_width })}
            />
          </label>
          <div className="check-row">
            <Toggle
              label="自动间隔"
              checked={state.interval_auto}
              onChange={(interval_auto) => patch({ interval_auto })}
            />
            <Toggle
              label="显示数值标签"
              checked={state.labels}
              onChange={(labels) => patch({ labels })}
            />
          </div>
          {!state.interval_auto && (
            <label className="field">
              间隔{state.color_by === "amplitude" ? "" : " · ms"}
              <Num
                label="等值线间隔"
                value={state.interval}
                min={0.01}
                step={1}
                onChange={(interval) => patch({ interval })}
              />
            </label>
          )}
        </fieldset>
      </Group>
    </div>
  );
  return (
    <>
      {controlsHost && createPortal(controls, controlsHost)}
      <div className={`viewer-card map-viewer${profileOn ? " with-profile" : ""}`} style={{ "--profile-share": profileShare, "--map-share": 100 - profileShare } as CSSProperties}>
        <div className="viewer-toolbar">
          <b title={presentation.title}>{presentation.title}</b>
          <div className="tools">
            <button aria-pressed={profileOn} className={profileOn ? "chosen" : ""}
              onClick={() => { setProfileOn(!profileOn); setPicking(null); }}>
              <ScanLine size={14} /> A–B 剖面
            </button>
            {profileOn && <div className="profile-pick-tools" role="group" aria-label="拾取剖面端点">
              {(["a", "b"] as const).map(point => <button key={point}
                aria-pressed={picking === point} className={picking === point ? "chosen" : ""}
                disabled={!data} onClick={() => setPicking(picking === point ? null : point)}>
                拾取 {point.toUpperCase()}
              </button>)}
            </div>}
            <span className="divider" />
            <button
              title="框选缩放"
              className={`icon ` + `${drag === "zoom" ? "chosen" : ""}`}
              onClick={() => setDrag("zoom")}
            >
              <MousePointer2 size={16} />
            </button>

            <button
              title="平移"
              className={`icon ` + `${drag === "pan" ? "chosen" : ""}`}
              onClick={() => setDrag("pan")}
            >
              <Move size={16} />
            </button>

            <span className="divider" />

            <button
              className="reset"
              onClick={() => patch({ x_range: null, y_range: null })}
            >
              <RotateCcw size={14} />
              重置
            </button>
          </div>
        </div>
        {picking && <div className="map-picking-hint" role="status">
          <MousePointer2 size={14} /> 拾取 {picking.toUpperCase()} 点
          <button className="icon" title="取消拾取（Esc）" onClick={() => setPicking(null)}><X size={14} /></button>
        </div>}
        <div className="map-plot-region" aria-busy={loading}>
        <div
          ref={plot}
          className="map-plot"
          data-picking={picking ? "true" : undefined}
          style={{
            visibility: data ? "visible" : "hidden",
          }}
        />
        {(error || mapIssue || loading) && (
          <p role={error ? "alert" : "status"} className={`map-status${error ? " map-status-error" : ""}`}>
            {error || mapIssue || "正在绘制层位地图…"}
          </p>
        )}
        </div>
        {profileOn && (
          <div className="map-profile">
            <div className="map-profile-head">
              <b>A–B 剖面</b>
              <span className="profile-status" role="status">
                {profileData ? `${profileData.curves.length} 条层位曲线` : ""}
              </span>
              <label className="profile-height-control">
                剖面高度
                <input type="range" min={30} max={70} value={profileShare} onChange={e => update("profileShare", +e.target.value)} />
              </label>
              <button className="icon" title="清除 A–B 端点" disabled={!profileA && !profileB} onClick={clearProfile}><RotateCcw size={14} /></button>
              <button className="secondary profile-export" disabled={!profileData || !!profileError || profilePending}
                onClick={() => setProfileExportOpen(true)}><Plus size={14} /> 保存剖面</button>
            </div>
            <div className="map-profile-plot-region" aria-busy={profilePending}>
            <div ref={profileRef} className="map-profile-plot" style={{ visibility: profileData ? "visible" : "hidden" }} />
            {!profileData && <p role={profileError ? "alert" : "status"} className={`map-profile-hint${profileError ? " map-status-error" : ""}`}>
              {profileError || (profilePending ? "正在更新剖面…" : mapIssue || "待选择 A、B 点")}
            </p>}
            </div>
            <div className="profile-legend" aria-label="剖面层位图例" style={{ visibility: profileData ? "visible" : "hidden" }}>
              {horizons.filter(h => h.visible).map(h => (
                <span key={h.id}><i style={{ background: h.color }} />{h.name}</span>
              ))}
            </div>
          </div>
        )}
      </div>
      {exportOpen && <ExportDialog title="层位地图 · 保存图件" settings={settings}
        onChange={p => setSettings(s => ({...s, ...p}))}
        onClose={onCloseExport} onExport={addToExport} busy={saving}
        disabled={!data || loading || !!mapIssue} error={error || mapIssue} rendering={false}
        dataset={dataset} onDataset={onDataset} datasetPlaceholder={datasetPlaceholder}
        colorbar={state.colorbar} onColorbar={colorbar => patch({colorbar})} />}

      {profileExportOpen && profileA && profileB && (
        <ExportDialog
          title="A–B 剖面 · 保存图件"
          profile
          settings={profileSettings}
          onChange={(p) => setProfileSettings((s) => ({ ...s, ...p }))}
          onClose={() => setProfileExportOpen(false)}
          onExport={async () => {
            if (!profileData || profileError || profilePending) return;
            setProfileExportBusy(true);
            try {
              await onAddProfileToExport({
                state,
                a: profileA,
                b: profileB,
                curve_colors: Object.fromEntries(
                  horizons
                    .filter((h) => h.visible)
                    .map((h) => [h.id, h.color]),
                ),
                colormap: seismic.colormap,
                reverse_colormap: seismic.reverse_colormap,
                settings: profileSettings,
              });
              setProfileExportOpen(false);
            } finally {
              setProfileExportBusy(false);
            }
          }}
          busy={profileExportBusy}
          disabled={!profileData || !!profileError || profilePending}
          error={profileError}
          rendering={false}
          dataset={dataset}
          onDataset={onDataset}
          datasetPlaceholder={datasetPlaceholder}
        />
      )}

    </>
  );
}
