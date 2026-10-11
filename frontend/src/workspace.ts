import type { Export3D, ExportDialogSettings, HS, Meta, VS } from "./types";

export type HorizonMapState = {
  horizon: string;
  color_by: "twt" | "amplitude" | "difference";
  display: string;
  colormap: string;
  reverse_colormap: boolean;
  range_mode: string;
  vmin: number | null;
  vmax: number | null;
  clip_percentile: number;
  difference_reference: string | null;
  difference_comparison: string | null;
  difference_type: "signed" | "absolute";
  show_statistics: boolean;
  contours: boolean;
  interval_auto: boolean;
  interval: number;
  line_width: number;
  labels: boolean;
  colorbar: boolean;
  x_range: [number, number] | null;
  y_range: [number, number] | null;
};

export type MapWorkspace = {
  state: HorizonMapState;
  settings: ExportDialogSettings;
  profileOn: boolean;
  profileA: [number, number] | null;
  profileB: [number, number] | null;
  profileSettings: ExportDialogSettings;
  drag: "zoom" | "pan";
};

export function initialMapWorkspace(): MapWorkspace {
  const settings: ExportDialogSettings = {
    format: "png", canvas: "fit", long_edge: 3000, background: "white",
    width: 180, height: 140, dpi: 300, font: "Times New Roman", font_size: 10,
    show_axes: true, show_labels: true, show_title: true,
  };
  return {
    state: {
      horizon: "", color_by: "twt", difference_reference: null,
      difference_comparison: null, difference_type: "signed", show_statistics: true,
      display: "filled_contour", colormap: "petrel", reverse_colormap: false,
      range_mode: "auto", vmin: null, vmax: null, clip_percentile: 99,
      contours: true, interval_auto: true, interval: 10, line_width: 0.5,
      labels: false, colorbar: true, x_range: null, y_range: null,
    },
    settings, profileOn: false, profileA: null, profileB: null, drag: "zoom",
    profileSettings: { ...settings, height: 80, show_curves: true, show_legend: true, show_ab: true },
  };
}

export const initialExport3D: Export3D = {
  format: "png", font: "Times New Roman", font_size: 10,
  canvas: "fit", long_edge: 3000, background: "white", width: 180, height: 120,
  dpi: 300, show_axes: true, show_axis_labels: true, show_bounding_box: true,
  interpolation: "bicubic",
};

export type WorkspaceState = {
  version: 1;
  view: VS;
  map: MapWorkspace;
  settings: ExportDialogSettings;
  settings3D: Export3D;
  dataset: string;
  selected: string;
  bytes: { il: number; xl: number };
  geometryMode: string;
  sidebar: boolean;
  drag: "zoom" | "pan";
};

export type WorkspaceResponse = {
  project_id: string | null;
  revision: number;
  metadata: Meta | null;
  horizons: HS[];
  state: WorkspaceState | null;
  updated_at?: string;
  source?: { ilbyte: number; xlbyte: number; geometry_mode: string };
  issues: { horizon_id: string | null; message: string }[];
};

/** New defaults survive upgrades while persisted source IDs stay authoritative. */
export function restoreState(defaults: WorkspaceState, saved: WorkspaceState | null, horizons: HS[]): WorkspaceState {
  const state = saved?.version === 1 ? saved : defaults;
  const ids = new Set(horizons.map(h => h.id));
  const map = state.map || defaults.map;
  return {
    ...defaults, ...state,
    view: {
      ...defaults.view, ...state.view,
      seismic: { ...defaults.view.seismic, ...state.view.seismic },
      scene: { ...defaults.view.scene, ...state.view.scene },
      horizons: horizons.map(h => ({ ...h, ...state.view.horizons.find(saved => saved.id === h.id), id: h.id, name: h.name })),
    },
    settings: { ...defaults.settings, ...state.settings },
    settings3D: { ...defaults.settings3D, ...state.settings3D },
    selected: ids.has(state.selected) ? state.selected : horizons[0]?.id || "",
    map: {
      ...defaults.map, ...map,
      state: {
        ...defaults.map.state, ...map.state,
        horizon: ids.has(map.state.horizon) ? map.state.horizon : horizons[0]?.id || "",
        difference_reference: ids.has(map.state.difference_reference || "") ? map.state.difference_reference : null,
        difference_comparison: ids.has(map.state.difference_comparison || "") ? map.state.difference_comparison : null,
      },
      settings: { ...defaults.map.settings, ...map.settings },
      profileSettings: { ...defaults.map.profileSettings, ...map.profileSettings },
    },
  };
}

export type WorkspaceDraft = {
  version: 1; project_id: string; revision: number; state: WorkspaceState;
  inflight?: WorkspaceState | null;
};
export const DRAFT_KEY = "seiscanvas.workspace.v1";

export function readDraft(storage: Pick<Storage, "getItem">, projectId: string, revision: number, serverState: WorkspaceState | null = null): WorkspaceState | null {
  try {
    const draft = JSON.parse(storage.getItem(DRAFT_KEY) || "null") as WorkspaceDraft | null;
    // A refresh can interrupt the response after the server saved the body.
    // Recover later edits only against that exact in-flight body and revision.
    const sameRevision = draft?.revision === revision;
    const interruptedSave = draft?.revision === revision - 1 && draft.inflight && serverState && JSON.stringify(draft.inflight) === JSON.stringify(serverState);
    return draft?.version === 1 && draft.project_id === projectId && (sameRevision || interruptedSave) && draft.state?.version === 1 ? draft.state : null;
  } catch {
    return null;
  }
}
