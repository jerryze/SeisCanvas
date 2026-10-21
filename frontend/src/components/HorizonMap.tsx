import ExportDialog from "./ExportDialog";
import { Layers, MousePointer2, Move, Plus, RotateCcw, ScanLine, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { HorizonMapState, MapWorkspace } from "../workspace";
import { reconcileMapWorkspace } from "../workspace";
import { mapPresentation, mapSelectionError, profileEndpointError, profileRequestKey, profileProbeRequest, profileHorizonStyleKey,
  PROFILE_MARGIN, profileContainerViewport, profileAspectPair, mapViewForKey } from "./horizonMapLogic";
import { createProfilePlotRenderer } from "./profilePlotRenderer";
import { createPortal } from "react-dom";
import Plotly from "plotly.js-dist-min";
import PlotScrollFrame, { isScrollPreview, updatePlotLayout, updatePlotData } from "./PlotScrollFrame";
import { coversViewport } from "./loadedRaster";
import { ordered } from "./plotScrollMath";
import type { HS, Section, VS, MapProfileOverlay } from "../types";
import type { ExportDialogSettings, SS } from "../types";
import { api } from "../api/client";
import { formatAmplitude } from "../format";
import { Group, Num, Toggle, SubsectionSummary, Select } from "./Controls";
import ColormapSelect, { colormapOptions } from "./ColormapSelect";
import { SeismicSettings } from "./panels/SeismicPanel";
import { buildTraces as sectionTraces } from "./SeismicViewer2D/sectionGeometry";
import { measureSectionViewport, samplingViewport, type SectionViewport } from "./SeismicViewer2D/sectionDisplay";
import { useOriginalProbe, ProbeReadout } from "./Probe";

type State = HorizonMapState;
type ProfileCurve = { id: string; name: string; values: (number | null)[] };
type ProfileData = {
  distance: number[];
  time: number[];
  /** Time-major heatmap rows: amplitude[time][position]. */
  amplitude: (number | null)[][];
  curves: ProfileCurve[];
  curve_distance: number[];
  a_distance: number;
  b_distance: number;
  path_start: [number, number];
  path_end: [number, number];
  vmin: number;
  vmax: number;
  label_y: string;
  distance_edges: number[];
  time_edges: number[];
  raster_extent: [number, number, number, number];
  preview_shape?: number[];
  x_range: [number, number];
  time_range: [number, number];
  trace_overlay: Section["trace_overlay"];
  background_interpolation: boolean;
  wiggle_interpolation: boolean;
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
  onSeismic,
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
  onSeismic: (patch: Partial<SS>) => void;
  /** Queue the standalone A–B profile figure (payload built here). */
  onAddProfileToExport: (payload: {
    state: State;
    a: [number, number];
    b: [number, number];
    curve_colors: Record<string, string>;
    colormap: string;
    reverse_colormap: boolean;
    settings: Record<string, unknown>;
    seismic: SS;
    aspect_ratio_2d: [number, number] | null;
    x_range: [number, number] | null;
    time_range: [number, number] | null;
    trace_viewport_width: number | null;
    trace_viewport_height: number | null;
    horizons: HS[];
    show_curves: boolean;
    show_legend: boolean;
    show_ab: boolean;
  }) => Promise<void>;
  exportOpen: boolean;
  onCloseExport: () => void;
  onReady: (v: boolean) => void;
  dataset: string;
  datasetPlaceholder?: string;
  onDataset: (value: string) => void;
  onAddToExport: (payload: { state: State; settings: Record<string, unknown>; profile: MapProfileOverlay | null }) => Promise<void>;
}) {
  const { state: savedState, settings, drag, profileOn, profileA, profileB, profileSettings } = workspace;
  const activeView = workspace.activeView ?? "map";
  const mapActive = activeView === "map";
  const sectionActive = activeView === "section";
  const profileAspectRatio = workspace.profileAspectRatio ?? null;
  const tabId = useId();
  const [mapDrawn, setMapDrawn] = useState(false);
  const [profileDrawn, setProfileDrawn] = useState(false);
  // Display mode controls contour visibility, including for older saved workspaces.
  const state = { ...savedState, contours: savedState.display !== "filled" };
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
  const setProfileDrag = (value: "zoom" | "pan") => update("profileDrag", value);
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
  const setActiveView = (view: "map" | "section") => { update("activeView", view); setPicking(null); };
  const returnToMap = () => { setActiveView("map"); setProfileOn(true); setPicking("a"); };
  const [profileResult, setProfileResult] = useState<{ key: string; contentKey: string; pathKey: string; data: ProfileData } | null>(null);
  const [profileFailure, setProfileFailure] = useState<{ key: string; message: string } | null>(null);
  const [profileExportOpen, setProfileExportOpen] = useState(false);
  const [profileExportBusy, setProfileExportBusy] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const profileRenderer = useRef<ReturnType<typeof createProfilePlotRenderer> | null>(null);
  const profileRenderedInputs = useRef<unknown[] | null>(null);
  const mapRenderedInputs = useRef<unknown[] | null>(null);
  const profileStyleKey = profileHorizonStyleKey(horizons);
  const profileVisibilityKey = JSON.stringify(horizons.map(h => [h.id, h.visible]));
  const [profileViewport, setProfileViewport] = useState<SectionViewport | null>(null);
  const { reading: profileReading, probe: probeProfile, reset: resetProfileProbe } = useOriginalProbe();
  function reportProfileViewport(el: any) {
    const viewport = measureSectionViewport(el._fullLayout);
    if (viewport) setProfileViewport(previous => previous?.width === viewport.width && previous?.height === viewport.height ? previous : viewport);
  }
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
  useEffect(() => {
    onWorkspace(current => reconcileMapWorkspace(current, horizons));
  }, [horizons, state.horizon, state.difference_reference, state.difference_comparison]);
  const profileSampling = samplingViewport(seismic, profileViewport);
  const profileQueryKey = profileRequestKey(state, horizonKey, profileA, profileB, seismic,
    profileSampling,
    workspace.profileXRange, workspace.profileTimeRange);
  const profileContentKey = profileRequestKey(state, horizonKey, profileA, profileB, seismic, null);
  const pathKey = JSON.stringify([profileA, profileB]);
  // Path geometry survives pending raster resampling and hidden-view resizing.
  const profilePath = profileResult?.pathKey === pathKey ? profileResult.data : null;
  const profilePathKey = profilePath ? JSON.stringify([profilePath.path_start, profilePath.path_end]) : "";
  const previousPath = useRef(pathKey);
  useEffect(() => {
    resetProfileProbe();
    if (previousPath.current !== pathKey) {
      previousPath.current = pathKey;
      onWorkspace(current => ({ ...current, profileXRange: null, profileTimeRange: null }));
    }
  }, [pathKey]);
  const endpointError = profileEndpointError(profileA, profileB);
  const profileData = !endpointError && !mapIssue && profileResult?.contentKey === profileContentKey ? profileResult.data : null;
  const profilePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const profileFresh = profileResult?.key === profileQueryKey || !!profileData && coversViewport(profileData,
    workspace.profileXRange ?? profileData.x_range, workspace.profileTimeRange ?? profileData.time_range,
    Math.round((profileViewport?.width || profileRef.current?.clientWidth || 1) * profilePixelRatio),
    Math.round((profileViewport?.height || profileRef.current?.clientHeight || 1) * profilePixelRatio),
    seismic.background_interpolation, seismic.wiggle || seismic.variable_area);
  const profileError = endpointError || (profileFailure?.key === profileQueryKey ? profileFailure.message : "");
  const validEndpoints = !!profileA && !!profileB && !endpointError;
  const profilePending = sectionActive && validEndpoints && !profileError && !mapIssue && !profileFresh;
  const setProfileError = (message: string) => setProfileFailure(message ? { key: profileQueryKey, message } : null);
  const profileErrorHandler = useRef(setProfileError);
  profileErrorHandler.current = setProfileError;
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
    setMapDrawn(false);
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
    if (!mapActive) return;
    if (!el || !data || !el.clientWidth || !el.clientHeight) {
      version.current++;
      setMapDrawn(false);
      return;
    }
    const inputs = [data, profileOn, profileA, profileB, profilePathKey, presentation.scalar, presentation.unit];
    const token = ++version.current;
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        if (token !== version.current) return;
        if (mapRenderedInputs.current?.every((value, i) => Object.is(value, inputs[i]))) {
          await updatePlotLayout(el, { width: el.clientWidth, height: el.clientHeight, dragmode: drag,
            "xaxis.range": state.x_range || [data.x[0] - .5, data.x.at(-1)! + .5],
            "yaxis.range": state.y_range || [data.y[0] - .5, data.y.at(-1)! + .5] });
          if (token === version.current) setMapDrawn(true);
          return;
        }
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
            colorbar: { title: { text: data.colorbar_title || "Time (ms)" } },
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
              colorbar: { title: { text: data.colorbar_title || "Time (ms)" } },
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
          if (profilePath) {
            for (const [from, to] of [
              [profilePath.path_start, profileA],
              [profileB, profilePath.path_end],
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
            width: el.clientWidth, height: el.clientHeight,
            margin: { l: 70, r: 100, t: 30, b: 60 },
            showlegend: false,
            dragmode: drag,
            paper_bgcolor: "#fff",
            plot_bgcolor: "#fff",
            font: { family: "DM Sans, 'PingFang SC', Arial, sans-serif", color: "#425367", size: 11 },
            annotations: abAnnotations,
            xaxis: {
              title: { text: "Crossline" },
              range: [...(state.x_range || [data.x[0] - 0.5, data.x.at(-1)! + 0.5])],
              constrain: "domain",
              showgrid: false,
            },
            yaxis: {
              title: { text: "Inline" },
              range: [...(state.y_range || [data.y[0] - 0.5, data.y.at(-1)! + 0.5])],
              scaleanchor: "x",
              scaleratio: 1,
              constrain: "domain",
              showgrid: false,
            },
          } as any,
          { responsive: false, scrollZoom: true, displayModeBar: false },
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
          if (isScrollPreview(el)) return;
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
        mapRenderedInputs.current = inputs;
        setMapDrawn(true);
      })
      .catch((e) => {
        setError(String(e));
        setMapDrawn(false);
      });
  }, [mapActive, data, state.x_range, state.y_range, drag, profileOn, profileA, profileB, profilePathKey, presentation.scalar, presentation.unit]);
  // Map coloring does not change the A–B seismic raster or horizon curves.
  useEffect(() => {
    if (!sectionActive || !profileA || !profileB || endpointError || mapIssue || profileFresh) return;
    const box = profileRef.current;
    if (!box?.clientWidth || !box.clientHeight) return;
    setProfileFailure(null);
    const abort = new AbortController();
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const box = profileRef.current!;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const res = await api("/horizon-map/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            state: JSON.parse(query),
            a: profileA,
            b: profileB,
            seismic,
            target_width: Math.max(8, Math.round((profileViewport?.width || box.clientWidth) * ratio)),
            target_height: Math.max(8, Math.round((profileViewport?.height || box.clientHeight) * ratio)),
            trace_viewport_width: profileViewport?.width || box.clientWidth,
            trace_viewport_height: profileViewport?.height || box.clientHeight,
            x_range: workspace.profileXRange, time_range: workspace.profileTimeRange,
          }),
          signal: abort.signal,
        });
        const result = await res.json();
        if (active) {
          if (result.background_interpolation !== seismic.background_interpolation)
            throw new Error("剖面显示后端版本不匹配，请重启 SeisCanvas 后端以启用插值和波形功能。");
          setProfileResult({ key: profileQueryKey, contentKey: profileContentKey, pathKey, data: result });
        }
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
  }, [sectionActive, profileQueryKey, profileContentKey, endpointError, mapIssue, profileFresh]);

  useEffect(() => {
    onReady(mapActive ? mapDrawn && !!data && !loading : profileDrawn && !!profileData && !profilePending && !profileError);
  }, [mapActive, mapDrawn, data, loading, profileDrawn, profileData, profilePending, profileError, onReady]);

  // The section occupies the same workspace as the map, with independent axes.
  useEffect(() => {
    const el = profileRef.current as any;
    if (!sectionActive || !el || !el.clientWidth || !el.clientHeight) return;
    if (!profileData) { setProfileDrawn(false); return; }
    const renderer = profileRenderer.current ??= createProfilePlotRenderer({ react: updatePlotData, restyle: Plotly.restyle,
      relayout: updatePlotLayout, purge: Plotly.purge } as any, el,
      message => profileErrorHandler.current(message));
    void renderer.visibility(horizons);
    const inputs = [profileData, maps, profileStyleKey, seismic];
    if (profileRenderedInputs.current?.every((value, i) => Object.is(value, inputs[i]))) {
      void renderer.resize(el.clientWidth, el.clientHeight, () => reportProfileViewport(el));
      const x = workspace.profileXRange || profileData.x_range;
      const t = workspace.profileTimeRange || profileData.time_range;
      void renderer.viewport({ "xaxis.range": x, "yaxis.range": [...t].reverse(), dragmode: workspace.profileDrag,
        "yaxis.scaleanchor": profileAspectRatio === null ? false : "x",
        "yaxis.scaleratio": profileAspectRatio === null ? 1 : Math.abs((x[1] - x[0]) / (t[1] - t[0])) / profileAspectRatio,
      }, () => setProfileDrawn(true));
      return;
    }
    setProfileDrawn(false);
    // Same colormap the 2D window uses, reversal included.
    const sharedSection: Section = { x: profileData.distance, time: profileData.time,
      x_edges: profileData.distance_edges, time_edges: profileData.time_edges,
      raster_extent: profileData.raster_extent, z: profileData.amplitude,
      vmin: profileData.vmin, vmax: profileData.vmax, trace_overlay: profileData.trace_overlay,
      horizons: Object.fromEntries(profileData.curves.map(curve => [curve.id,
        profileData.curve_distance.map((x, n) => [x, curve.values[n]])])) as Section["horizons"] };
    // Keep every loaded horizon's trace slot. Toggling it only restyles visibility.
    const traces = sectionTraces(sharedSection, { seismic, horizons: horizons.map(h => ({ ...h, visible: true })), view_type: "inline", section_number: 0 } as VS,
      maps[seismic.colormap] || [], "距离 (网格)");
    traces[0].hovertemplate = "距离 %{x:.1f}<br>Time %{y:.1f} ms<extra></extra>";
    const xRange = workspace.profileXRange || profileData.x_range;
    const timeRange = workspace.profileTimeRange || profileData.time_range;
    const abShape = (x: number) => ({
      type: "line",
      x0: x,
      x1: x,
      yref: "y domain",
      y0: 0,
      y1: 1,
      line: { color: "#365985", width: 1.5, dash: "dot" },
    });
    const abLabel = (x: number, text: string) => ({
      x,
      yref: "y domain",
      y: 1,
      yshift: 4,
      yanchor: "bottom",
      text,
      showarrow: false,
      font: { color: "#365985", size: 11 },
    });
    void renderer.render(
      traces,
      {
        width: el.clientWidth, height: el.clientHeight,
        margin: PROFILE_MARGIN,
        dragmode: workspace.profileDrag,
        showlegend: false,
        paper_bgcolor: "#fff",
        plot_bgcolor: "#fff",
        font: { family: "DM Sans, 'PingFang SC', Arial, sans-serif", color: "#425367", size: 11 },
        xaxis: { title: { text: "距离 (网格)", standoff: 8 }, showgrid: false, linecolor: "#bcc8cf", ticks: "outside",
          range: [...xRange], autorange: false, constrain: "domain", layer: "above traces" },
        yaxis: {
          title: { text: profileData.label_y, standoff: 4 },
          range: [...timeRange].reverse(),
          autorange: false,
          scaleanchor: profileAspectRatio === null ? false : "x",
          scaleratio: profileAspectRatio === null ? 1 : Math.abs((xRange[1] - xRange[0]) / (timeRange[1] - timeRange[0])) / profileAspectRatio,
          constrain: "domain",
          showgrid: false,
          linecolor: "#bcc8cf",
          ticks: "outside",
          layer: "above traces",
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
      { responsive: false, displayModeBar: false, scrollZoom: true },
      () => {
        profileRenderedInputs.current = inputs;
        setProfileDrawn(true);
        reportProfileViewport(el);
        el.removeAllListeners?.("plotly_relayout");
        el.removeAllListeners?.("plotly_hover");
        el.on("plotly_hover", (event: any) => {
          const point = event?.points?.[0];
          if (!point) return;
          const request = profileProbeRequest(profileData, point);
          if (request) probeProfile(request);
        });
        el.on("plotly_relayout", (event: any) => {
          if (isScrollPreview(el)) return;
          if (event["xaxis.autorange"] || event["yaxis.autorange"]) {
            onWorkspace(current => ({ ...current, profileXRange: null, profileTimeRange: null }));
          } else if (event["xaxis.range[0]"] !== undefined || event["yaxis.range[0]"] !== undefined) {
            onWorkspace(current => ({ ...current,
              profileXRange: event["xaxis.range[0]"] !== undefined ? [event["xaxis.range[0]"], event["xaxis.range[1]"]] : current.profileXRange,
              profileTimeRange: event["yaxis.range[0]"] !== undefined ? [event["yaxis.range[1]"], event["yaxis.range[0]"]] : current.profileTimeRange,
            }));
          }
        });
      },
    );
  }, [sectionActive, profileData, maps, profileStyleKey, seismic, profileAspectRatio, workspace.profileDrag, workspace.profileXRange, workspace.profileTimeRange]);

  useEffect(() => {
    if (sectionActive && profileData) void profileRenderer.current?.visibility(horizons);
  }, [sectionActive, profileData, profileVisibilityKey]);

  useEffect(() => {
    if (!sectionActive) return;
    const el = profileRef.current;
    if (!el) return;
    let frame = 0;
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const viewport = profileContainerViewport(el.clientWidth, el.clientHeight, profileAspectRatio);
        if (!viewport) return;
        setProfileViewport(previous => previous?.width === viewport.width && previous?.height === viewport.height ? previous : viewport);
        void profileRenderer.current?.resize(el.clientWidth, el.clientHeight, () => reportProfileViewport(el));
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [sectionActive, profileAspectRatio]);

  useEffect(() => {
    if (!mapActive) return;
    const el = plot.current!;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const chart = el as any;
        if (chart.data && el.clientWidth && el.clientHeight &&
            (chart._fullLayout?.width !== el.clientWidth || chart._fullLayout?.height !== el.clientHeight)) {
          queue.current = queue.current.catch(() => {}).then(() =>
            Plotly.relayout(el, { width: el.clientWidth, height: el.clientHeight })).then(() => {}).catch(error => setError(String(error)));
        }
      });
    });
    observer.observe(el);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); version.current++; };
  }, [mapActive]);

  // Only unmounting the module releases graphs; tabs preserve their instances.
  useEffect(() => {
    const el = plot.current!;
    return () => {
      version.current++;
      queue.current.finally(() => Plotly.purge(el));
      void profileRenderer.current?.dispose();
      profileRenderer.current = null;
    };
  }, []);
  async function addToExport() {
    if (!data || loading || mapIssue) return;
    setSaving(true);
    try {
      await onAddToExport({ state, settings,
        profile: validEndpoints && settings.show_ab !== false ? {
          a: profileA!, b: profileB!,
          ...(profileOn && profilePath ? { path_start: profilePath.path_start, path_end: profilePath.path_end } : {}),
        } : null,
      });
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
            "地图层位",
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
            ["twt", "Time"],
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
            <label className="map-field-label" title="ΔTime = 对比层位 − 参考层位">差值类型</label>
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
      <Group icon={<ScanLine size={16} />} title="地图等值线" defaultOpen={false}>
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
      <Group
        icon={<ScanLine size={16} />}
        title="剖面设置"
        defaultOpen={profileOn || sectionActive}
      >
        <Toggle
          label="绘制剖面线"
          title="在地图上拾取 A、B 端点；在“A–B 剖面”页签查看结果"
          checked={profileOn}
          onChange={(value) => {
            setProfileOn(value);
            setPicking(null);
          }}
        />
        {(profileOn || sectionActive) && (
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
            <div className="section-number" role="group" aria-label="A–B 剖面横纵比">
              <Toggle label="固定横纵比" title="固定横向与纵向的比例；取消后自动适应工作区"
                checked={profileAspectRatio !== null}
                onChange={enabled => update("profileAspectRatio", enabled ? 2 : null)} />
              <Num label="A–B 横纵比（横÷纵）" title="横÷纵，例如 2 表示 2:1"
                disabled={profileAspectRatio === null} value={profileAspectRatio ?? 2}
                min={0.02} max={50} step={0.1}
                onChange={ratio => update("profileAspectRatio", ratio)} />
            </div>
            <button className="panel-action" disabled={!profileA && !profileB} onClick={clearProfile}>
              清除 A–B 端点
            </button>
            <details className="subsettings">
              <SubsectionSummary title="地震显示" />
              <div className="subsettings-body">
                <p className="control-note">与 2D 剖面、3D 切片共用地震显示设置。</p>
                <SeismicSettings seismic={seismic} maps={maps} onSeismic={onSeismic} />
              </div>
            </details>
          </div>
        )}
      </Group>

    </div>
  );
  return (
    <>
      {controlsHost && createPortal(controls, controlsHost)}
      <div className="viewer-card map-viewer">
        <div className="map-view-tabs" role="tablist" aria-label="层位地图视图">
          {(["map", "section"] as const).map(view => <button key={view}
            id={`${tabId}-${view}-tab`} role="tab" aria-selected={activeView === view}
            aria-controls={`${tabId}-${view}-panel`} tabIndex={activeView === view ? 0 : -1}
            onClick={() => setActiveView(view)} onKeyDown={event => {
              const next = mapViewForKey(view, event.key);
              if (!next) return;
              event.preventDefault();
              setActiveView(next);
              document.getElementById(`${tabId}-${next}-tab`)?.focus();
            }}>{view === "map" ? "地图" : "A–B 剖面"}</button>)}
        </div>
        <div className="map-view-content">
        <section id={`${tabId}-map-panel`} role="tabpanel" aria-labelledby={`${tabId}-map-tab`}
          aria-hidden={!mapActive} inert={!mapActive} className={`map-view-panel${mapActive ? " is-active" : ""}`}>
        <div className="viewer-toolbar">
          <b title={presentation.title}>{presentation.title}</b>
          <div className="tools">
            <button aria-pressed={profileOn} className={profileOn ? "chosen" : ""}
              title="在地图上拾取 A、B 端点；在“A–B 剖面”页签查看结果"
              onClick={() => { setProfileOn(!profileOn); setPicking(null); }}>
              <ScanLine size={14} /> 绘制剖面线
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
        <PlotScrollFrame plotRef={plot}
          xBounds={data ? [data.x[0] - .5, data.x.at(-1)! + .5] : null}
          yBounds={data ? [data.y[0] - .5, data.y.at(-1)! + .5] : null}
          xLabel="Crossline" yLabel="Inline" onError={setError}
          onCommit={({ x, y }) => patch({ x_range: x, y_range: y })}>
        <div
          ref={plot}
          className="map-plot"
          data-picking={picking ? "true" : undefined}
          style={{
            visibility: mapActive && data ? "visible" : "hidden",
          }}
        />
        </PlotScrollFrame>
        {(error || mapIssue || loading) && (
          <p role={error ? "alert" : "status"} className={`map-status${error ? " map-status-error" : ""}`}>
            {error || mapIssue || "正在绘制层位地图…"}
          </p>
        )}
        </div>
        </section>
        <section id={`${tabId}-section-panel`} role="tabpanel" aria-labelledby={`${tabId}-section-tab`}
          aria-hidden={!sectionActive} inert={!sectionActive} className={`map-view-panel map-profile${sectionActive ? " is-active" : ""}`}>
            <div className="viewer-toolbar">
              <div className="viewer-label"><b>A–B 剖面</b>
              <span className="profile-status" role="status">
                {profileData ? `${profileData.curves.filter(curve => horizons.some(h => h.id === curve.id && h.visible)).length} 条层位曲线` : ""}
              </span>
              </div>
              <div className="tools">
                <button title="框选缩放" className={`icon${workspace.profileDrag === "zoom" ? " chosen" : ""}`}
                  onClick={() => setProfileDrag("zoom")}><MousePointer2 size={16} /></button>
                <button title="平移" className={`icon${workspace.profileDrag === "pan" ? " chosen" : ""}`}
                  onClick={() => setProfileDrag("pan")}><Move size={16} /></button>
                <span className="divider" />
                <button className="reset" disabled={!profileData} onClick={() => onWorkspace(current => ({
                  ...current, profileXRange: null, profileTimeRange: null,
                }))}><RotateCcw size={14} /> 重置</button>
                <button className="profile-export" disabled={!profileData || !!profileError || profilePending}
                  onClick={() => setProfileExportOpen(true)}><Plus size={14} /> 保存剖面</button>
              </div>
            </div>
            <div className="map-profile-plot-region" aria-busy={profilePending}>
            <PlotScrollFrame plotRef={profileRef}
              xBounds={profilePath?.x_range ?? null} yBounds={profilePath?.time_range ?? null}
              xLabel="距离 (网格)" yLabel="Time (ms)" onError={setProfileError}
              onCommit={({ x, y }) => onWorkspace(current => ({ ...current, profileXRange: x, profileTimeRange: ordered(y) }))}>
            <div ref={profileRef} className="map-profile-plot" style={{ visibility: sectionActive && profileData ? "visible" : "hidden" }} />
            </PlotScrollFrame>
            {!profileData && <div role={validEndpoints && profileError ? "alert" : "status"} className="map-profile-hint">
              <p>{!validEndpoints ? endpointError || "请返回地图拾取 A、B 点。" : profileError || mapIssue || "正在更新剖面…"}</p>
              {(!validEndpoints || mapIssue || profileError) && <button className="secondary" onClick={returnToMap}>返回地图</button>}
            </div>}
            </div>
            <div className="profile-footer" style={{ visibility: sectionActive && profileData ? "visible" : "hidden" }}>
            <div className="profile-readout-slot"><ProbeReadout reading={profileReading} /></div>
            <div className="profile-legend" aria-label="剖面层位图例">
              {horizons.map(h => (
                <span key={h.id} aria-hidden={!h.visible || !profileData}
                  style={{ visibility: sectionActive && h.visible && profileData ? "visible" : "hidden" }}>
                  <i style={{ background: h.color }} />{h.name}
                </span>
              ))}
            </div>
            </div>
        </section>
        </div>
      </div>
      {exportOpen && mapActive && <ExportDialog title="层位地图 · 保存图件" settings={settings}
        mapProfileAvailable={validEndpoints}
        onChange={p => setSettings(s => ({...s, ...p}))}
        onClose={onCloseExport} onExport={addToExport} busy={saving}
        disabled={!data || loading || !!mapIssue} error={error || mapIssue} rendering={false}
        dataset={dataset} onDataset={onDataset} datasetPlaceholder={datasetPlaceholder}
        colorbar={state.colorbar} onColorbar={colorbar => patch({colorbar})} />}

      {(profileExportOpen || (exportOpen && sectionActive)) && profileA && profileB && (
        <ExportDialog
          title="A–B 剖面 · 保存图件"
          profile
          settings={profileSettings}
          onChange={(p) => setProfileSettings((s) => ({ ...s, ...p }))}
          onClose={() => { setProfileExportOpen(false); onCloseExport(); }}
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
                seismic, aspect_ratio_2d: profileAspectPair(profileAspectRatio),
                x_range: workspace.profileXRange, time_range: workspace.profileTimeRange,
                trace_viewport_width: profileViewport?.width || null,
                trace_viewport_height: profileViewport?.height || null,
                horizons,
                show_curves: profileSettings.show_curves !== false,
                show_legend: profileSettings.show_legend !== false,
                show_ab: profileSettings.show_ab !== false,
              });
              setProfileExportOpen(false);
              onCloseExport();
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
