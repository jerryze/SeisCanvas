import type { HorizonMapState, MapWorkspace } from "../workspace";
import type { HS, SS } from "../types";
import type { ProbeRequest } from "./Probe";

export const PROFILE_MARGIN = { l: 72, r: 24, t: 28, b: 56 };

/** Resolve unavailable seismic views before making requests from restored state. */
export function mapWorkspaceForData(workspace: MapWorkspace, hasSeismic: boolean): MapWorkspace {
  if (hasSeismic) return workspace;
  const amplitude = workspace.state.color_by === "amplitude";
  if (!amplitude) return workspace;
  return {
    ...workspace,
    state: amplitude ? {
      ...workspace.state, color_by: "twt", colormap: "petrel",
      range_mode: "auto", vmin: null, vmax: null, interval_auto: true,
    } : workspace.state,
  };
}

/** Measure the visible section, including letterboxing, before Plotly exists. */
export function profileContainerViewport(width: number, height: number, aspectRatio: number | null = null) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const availableWidth = Math.max(8, width - PROFILE_MARGIN.l - PROFILE_MARGIN.r);
  const availableHeight = Math.max(8, height - PROFILE_MARGIN.t - PROFILE_MARGIN.b);
  const fixed = aspectRatio !== null && Number.isFinite(aspectRatio) && aspectRatio > 0;
  return { width: Math.max(8, Math.round(fixed ? Math.min(availableWidth, availableHeight * aspectRatio) : availableWidth)),
    height: Math.max(8, Math.round(fixed ? Math.min(availableHeight, availableWidth / aspectRatio) : availableHeight)) };
}

/** Reuse the existing export API while keeping both components in its 0.1–5 bounds. */
export function profileAspectPair(ratio: number | null): [number, number] | null {
  if (ratio === null) return null;
  return ratio >= 1 ? [5, 5 / ratio] : [5 * ratio, 5];
}

export function mapViewForKey(current: "map" | "section", key: string) {
  if (key === "Home") return "map";
  if (key === "End") return "section";
  if (key === "ArrowLeft" || key === "ArrowRight") return current === "map" ? "section" : "map";
  return null;
}

/** Geometry/style invalidation deliberately excludes app-level visibility. */
export function profileHorizonStyleKey(horizons: HS[]) {
  return JSON.stringify(horizons.map(h => [h.id, h.name, h.color, h.line, h.marker, h.outline]));
}

/** Cursor amplitude queries use original SEG-Y coordinates, never Sinc pixels. */
export function profileProbeRequest(profile: {
  x_range: [number, number]; path_start: [number, number]; path_end: [number, number];
}, point: { x: number; y: number }): ProbeRequest | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const span = profile.x_range[1] - profile.x_range[0];
  if (span <= 0) return null;
  const fraction = Math.max(0, Math.min(1, (point.x - profile.x_range[0]) / span));
  return { kind: "inline", position: profile.path_start[0] + fraction * (profile.path_end[0] - profile.path_start[0]),
    crossline: profile.path_start[1] + fraction * (profile.path_end[1] - profile.path_start[1]), time: point.y };
}

/** The A–B raster depends on geometry and sampling, not map color settings. */
export function profileRequestKey(
  state: Pick<HorizonMapState, "horizon">,
  horizonKey: string,
  a: [number, number] | null,
  b: [number, number] | null,
  seismic: SS,
  viewport?: { width: number | null; height: number | null } | null,
  xRange?: [number, number] | null,
  timeRange?: [number, number] | null,
) {
  return JSON.stringify({
    horizon: state.horizon, horizonKey, a, b,
    seismic: { background_interpolation: seismic.background_interpolation,
      wiggle_interpolation: seismic.wiggle_interpolation,
      wiggle: seismic.wiggle, variable_area: seismic.variable_area, wiggle_gain: seismic.wiggle_gain,
      clip_mode: seismic.clip_mode, clip_percentile: seismic.clip_percentile,
      symmetric: seismic.symmetric, vmin: seismic.vmin, vmax: seismic.vmax,
      reverse_polarity: seismic.reverse_polarity },
    viewport, xRange, timeRange,
  });
}

export function mapPresentation(state: HorizonMapState, horizons: Pick<HS, "id" | "name">[]) {
  const name = (id: string | null) => horizons.find(h => h.id === id)?.name;
  if (state.color_by === "difference") {
    const formula = `${name(state.difference_comparison) || "请选择对比层位"} − ${name(state.difference_reference) || "请选择参考层位"}`;
    return {
      title: `层位差值 · ${state.difference_type === "absolute" ? `|${formula}|` : formula}`,
      scalar: state.difference_type === "absolute" ? "|ΔTime|" : "ΔTime",
      unit: "ms",
    };
  }
  return {
    title: `${state.color_by === "amplitude" ? "沿层振幅" : "层位时间"} · ${name(state.horizon) || "请导入层位"}`,
    scalar: state.color_by === "amplitude" ? "振幅" : "Time",
    unit: state.color_by === "amplitude" ? "" : "ms",
  };
}

export function profileEndpointError(a: [number, number] | null, b: [number, number] | null) {
  if (!a || !b) return "";
  if (![...a, ...b].every(Number.isFinite)) return "A、B 坐标必须是有效数字。";
  return a[0] === b[0] && a[1] === b[1] ? "A、B 不能重合，请重新拾取或修改坐标。" : "";
}

export function mapSelectionError(state: HorizonMapState, horizons: Pick<HS, "id">[]) {
  const loaded = (id: string | null) => horizons.some(h => h.id === id);
  if (!loaded(state.horizon)) return "请先导入或选择已加载的层位。";
  if (state.color_by !== "difference") return "";
  if (horizons.length < 2) return "差值计算需要两个不同层位，请添加层位或切换颜色变量。";
  if (!loaded(state.difference_reference) || !loaded(state.difference_comparison)) return "请选择已加载的参考层位和对比层位，以继续计算差值。";
  return state.difference_reference === state.difference_comparison ? "参考层位和对比层位不能相同，请选择两个不同层位。" : "";
}
