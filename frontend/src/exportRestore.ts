import type { Export3D, ExportDialogSettings, HS, Meta, SS, VS, MapProfileOverlay } from "./types";
import type { HorizonMapState, WorkspaceState } from "./workspace";

type MapState = Omit<HorizonMapState, "interval" | "interval_auto"> & { interval: number | null };
type ProfileRequest = {
  state: MapState; settings: ExportDialogSettings;
  a: [number, number]; b: [number, number]; seismic: SS | null;
  colormap: string; reverse_colormap: boolean; horizons: HS[] | null;
  curve_colors: Record<string, string>;
  x_range: [number, number] | null; time_range: [number, number] | null;
  aspect_ratio_2d: [number, number] | null;
  show_curves: boolean; show_legend: boolean; show_ab: boolean;
};
export type ExportRestore = { version: 1; warnings: string[] } & (
  | { kind: "2d"; request: { state: Pick<VS, "view_type" | "section_number" | "x_range" | "time_range" | "aspect_ratio_2d" | "seismic" | "horizons" | "smooth_horizons" | "horizon_sg" | "horizon_sg_window">; settings: ExportDialogSettings } }
  | { kind: "3d"; request: { state: Pick<VS, "seismic" | "slices" | "scene" | "horizons">; settings: Export3D } }
  | { kind: "map"; request: { state: MapState; settings: ExportDialogSettings; profile: MapProfileOverlay | null } }
  | { kind: "profile"; request: ProfileRequest }
);

/** Build the complete next presentation before touching React or autosave. */
export function restoreFigure(current: WorkspaceState, snapshot: ExportRestore, meta: Meta | null, hasSeismic = !!meta): WorkspaceState {
  if (snapshot.version !== 1) throw new Error("不支持的图件快照版本。");
  const requireGeometry = () => {
    if (!meta) throw new Error("无法恢复：请先导入层位或 SEG-Y 数据。");
    return meta;
  };
  const requireSurvey = () => {
    if (!hasSeismic) throw new Error("无法恢复：振幅着色需要先导入 SEG-Y。");
    return requireGeometry();
  };
  const next = structuredClone(current);
  const ids = new Set(current.view.horizons.map(h => h.id));
  const requireHorizon = (id: string | null) => {
    if (!id || !ids.has(id)) throw new Error(`无法恢复：所需层位已移除（${id || "未指定"}）。`);
  };
  const styles = (saved: HS[] | null) => {
    if (saved === null) throw new Error("图件缺少层位显示设置。");
    saved.forEach(h => requireHorizon(h.id));
    const restored = current.view.horizons.map(h => {
      const old = saved.find(s => s.id === h.id);
      // Added layers must not silently become part of an earlier figure.
      return old ? { ...h, ...old, id: h.id, name: h.name } : { ...h, visible: false };
    });
    // Restored colours also apply to corresponding members imported later;
    // those members remain hidden and retain their current model assignment.
    const colors = new Map(saved.filter(h => h.horizon_key).map(h => [h.horizon_key, h.color]));
    return restored.map(h => h.horizon_key && colors.has(h.horizon_key) ? { ...h, color: colors.get(h.horizon_key)! } : h);
  };
  const validRange = (range: [number, number] | null, bounds?: number[]) => {
    if (range && (!range.every(Number.isFinite) || range[0] >= range[1] || (bounds && (range[1] < bounds[0] || range[0] > bounds.at(-1)!))))
      throw new Error("无法恢复：图件范围与当前数据不匹配。");
  };
  const endpoint = (point: [number, number]) => {
    const survey = requireGeometry();
    if (!point || !point.every(Number.isFinite) || point[0] < survey.inlines[0] || point[0] > survey.inlines.at(-1)! || point[1] < survey.crosslines[0] || point[1] > survey.crosslines.at(-1)!)
      throw new Error("无法恢复：A–B 端点超出当前数据范围。");
  };
  if (snapshot.kind === "2d") {
    const survey = requireGeometry();
    const { state, settings } = snapshot.request;
    const sections = state.view_type === "inline" ? survey.inlines : survey.crosslines;
    if (!sections.includes(state.section_number)) throw new Error("无法恢复：当前数据中没有该剖面。");
    validRange(state.x_range, state.view_type === "inline" ? survey.crosslines : survey.inlines);
    validRange(state.time_range, survey.time_range);
    next.view = { ...next.view, ...state, view_mode: "2d", horizons: styles(state.horizons) };
    next.settings = { ...next.settings, ...settings };
  } else if (snapshot.kind === "3d") {
    const survey = requireGeometry();
    const { state, settings } = snapshot.request;
    if (state.horizons.some(h => h.visible && h.display_mode === "full_surface" && h.color_by === "amplitude")) requireSurvey();
    for (const kind of ["inline", "crossline", "time"] as const) {
      for (const slice of state.slices[kind]) {
        const valid = kind === "time" ? Number.isFinite(slice.position) && slice.position >= survey.time_range[0] && slice.position <= survey.time_range[1]
          : (kind === "inline" ? survey.inlines : survey.crosslines).includes(slice.position);
        if (!valid) throw new Error("无法恢复：切片位置超出当前数据范围。");
      }
    }
    next.view = { ...next.view, ...state, view_mode: "3d", horizons: styles(state.horizons),
      scene: { ...state.scene, camera: state.scene.camera ?? current.view.scene.camera } };
    next.settings3D = { ...next.settings3D, ...settings };
  } else if (snapshot.kind === "map" || snapshot.kind === "profile") {
    const { state, settings } = snapshot.request;
    // Time/difference maps use horizon extents, even after a survey is attached.
    const surveyBounds = state.color_by === "amplitude" ? requireSurvey()
      : snapshot.kind === "profile" || snapshot.request.profile ? requireGeometry() : null;
    requireHorizon(state.horizon);
    if (state.color_by === "difference") {
      requireHorizon(state.difference_reference);
      requireHorizon(state.difference_comparison);
    }
    validRange(state.x_range, surveyBounds?.crosslines);
    validRange(state.y_range, surveyBounds?.inlines);
    next.view.view_mode = "map";
    next.map.state = { ...state, interval_auto: state.interval === null, interval: state.interval ?? 10 };
    if (snapshot.kind === "map") {
      const profile = snapshot.request.profile;
      if (profile) { endpoint(profile.a); endpoint(profile.b); }
      next.map = { ...next.map, activeView: "map", settings: { ...next.map.settings, ...settings, show_ab: !!profile },
        profileOn: !!profile, profileA: profile?.a ?? null, profileB: profile?.b ?? null,
        profileXRange: null, profileTimeRange: null };
    } else {
      const survey = requireGeometry();
      const req = snapshot.request;
      endpoint(req.a); endpoint(req.b);
      if (req.a[0] === req.b[0] && req.a[1] === req.b[1]) throw new Error("A、B 端点不能重合。");
      validRange(req.time_range, survey.time_range);
      next.view.seismic = req.seismic ?? { ...next.view.seismic, colormap: req.colormap, reverse_colormap: req.reverse_colormap };
      next.view.horizons = styles(req.horizons);
      next.map = { ...next.map, activeView: "section", profileOn: true, profileA: req.a, profileB: req.b,
        profileXRange: req.x_range, profileTimeRange: req.time_range,
        profileAspectRatio: req.aspect_ratio_2d ? req.aspect_ratio_2d[0] / req.aspect_ratio_2d[1] : null,
        profileSettings: { ...next.map.profileSettings, ...settings, show_curves: req.show_curves, show_legend: req.show_legend, show_ab: req.show_ab } };
    }
  } else {
    throw new Error("不支持的图件类型。");
  }
  return next;
}
