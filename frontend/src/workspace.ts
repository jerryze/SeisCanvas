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
  activeView: "map" | "section";
  state: HorizonMapState;
  settings: ExportDialogSettings;
  profileOn: boolean;
  profileA: [number, number] | null;
  profileB: [number, number] | null;
  profileXRange: [number, number] | null;
  profileTimeRange: [number, number] | null;
  /** Plot width / height; null fills the available workspace automatically. */
  profileAspectRatio: number | null;
  profileSettings: ExportDialogSettings;
  drag: "zoom" | "pan";
  profileDrag: "zoom" | "pan";
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
    activeView: "map", settings, profileOn: false, profileA: null, profileB: null, drag: "zoom", profileDrag: "zoom",
    profileXRange: null, profileTimeRange: null, profileAspectRatio: null,
    profileSettings: { ...settings, height: 80, show_curves: true, show_legend: true, show_ab: true },
  };
}

/** Upgrade old split-pane workspaces without retaining their height control. */
export function normalizeMapWorkspace(map: MapWorkspace): MapWorkspace {
  const { profileShare: _obsoleteHeight, ...saved } = map as MapWorkspace & { profileShare?: number };
  return { ...initialMapWorkspace(), ...saved,
    activeView: saved.activeView === "section" ? "section" : "map",
    profileDrag: saved.profileDrag === "pan" ? "pan" : "zoom",
    profileAspectRatio: typeof saved.profileAspectRatio === "number" && Number.isFinite(saved.profileAspectRatio)
      && saved.profileAspectRatio >= 0.02 && saved.profileAspectRatio <= 50 ? saved.profileAspectRatio : null,
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
  sidebarValues?: Record<string, string | boolean>;
  sidebarScroll?: Record<string, number>;
};

export type WorkspaceResponse = {
  project_id: string | null;
  revision: number;
  name?: string;
  activation_epoch?: string;
  notice?: string;
  metadata: Meta | null;
  horizon_metadata?: Meta | null;
  horizons: HS[];
  state: WorkspaceState | null;
  updated_at?: string;
  source?: { ilbyte: number; xlbyte: number; geometry_mode: string } | null;
  issues: { horizon_id: string | null; message: string }[];
};

/** Never silently replace a deleted member of a scientific comparison. */
export function reconcileMapWorkspace(map: MapWorkspace, horizons: Pick<HS, "id">[]): MapWorkspace {
  const ids = new Set(horizons.map(h => h.id));
  const horizon = ids.has(map.state.horizon) ? map.state.horizon : horizons[0]?.id || "";
  const reference = ids.has(map.state.difference_reference || "") ? map.state.difference_reference : null;
  const comparison = ids.has(map.state.difference_comparison || "") ? map.state.difference_comparison : null;
  if (horizon === map.state.horizon && reference === map.state.difference_reference && comparison === map.state.difference_comparison) return map;
  return {
    ...map,
    state: {
      ...map.state, horizon, difference_reference: reference, difference_comparison: comparison,
      range_mode: "auto", vmin: null, vmax: null, x_range: null, y_range: null,
    },
  };
}

/** New defaults survive upgrades while persisted source IDs stay authoritative. */
export function restoreState(defaults: WorkspaceState, saved: WorkspaceState | null, horizons: HS[]): WorkspaceState {
  const state = saved?.version === 1 ? saved : defaults;
  const ids = new Set(horizons.map(h => h.id));
  const map = normalizeMapWorkspace(state.map || defaults.map);
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
  updated_at?: string;
};
export const DRAFT_KEY = "seiscanvas.workspace.v1";
export function draftTabId(): string {
  try {
    const key = "seiscanvas.tab";
    let id = sessionStorage.getItem(key);
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(key, id); }
    return id;
  } catch { return "default"; }
}
export const draftKey = (projectId: string, tabId: string) => `seiscanvas.workspace.v2:${projectId}:${tabId}`;

export function removeProjectDrafts(storage: Pick<Storage, "getItem" | "key" | "length" | "removeItem">, projectId: string) {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(draftKey(projectId, ""))) keys.push(key);
  }
  try {
    if (JSON.parse(storage.getItem(DRAFT_KEY) || "null")?.project_id === projectId) keys.push(DRAFT_KEY);
  } catch { /* An unidentifiable legacy draft may belong to another project. */ }
  keys.forEach(key => storage.removeItem(key));
}

export type DraftCandidate = WorkspaceDraft & { key: string; compatible: boolean };

/** A restarted browser has a new tab ID; recover only unambiguous drafts. */
export function projectDrafts(storage: Pick<Storage, "getItem" | "key" | "length">, projectId: string, revision: number, serverState: WorkspaceState | null): DraftCandidate[] {
  const result: DraftCandidate[] = [];
  try {
    const keys = [DRAFT_KEY];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(`seiscanvas.workspace.v2:${projectId}:`)) keys.push(key);
    }
    for (const key of keys) {
      try {
        const draft = JSON.parse(storage.getItem(key) || "null") as WorkspaceDraft | null;
        if (!draft || draft.version !== 1 || draft.project_id !== projectId || draft.state?.version !== 1 || !draft.state.view || !Array.isArray(draft.state.view.horizons)) continue;
        if (JSON.stringify(draft.state) === JSON.stringify(serverState)) continue;
        const compatible = draft.revision === revision || !!(draft.revision === revision - 1 && draft.inflight && serverState && JSON.stringify(draft.inflight) === JSON.stringify(serverState));
        result.push({ ...draft, key, compatible });
      } catch { /* Invalid drafts cannot overwrite a valid project. */ }
    }
  } catch { /* Browser storage is optional. */ }
  return result;
}

export function readDraft(storage: Pick<Storage, "getItem">, projectId: string, revision: number, serverState: WorkspaceState | null = null, tabId?: string): WorkspaceState | null {
  try {
    const draft = JSON.parse((tabId ? storage.getItem(draftKey(projectId, tabId)) : null) || storage.getItem(DRAFT_KEY) || "null") as WorkspaceDraft | null;
    // A refresh can interrupt the response after the server saved the body.
    // Recover later edits only against that exact in-flight body and revision.
    const sameRevision = draft?.revision === revision;
    const interruptedSave = draft?.revision === revision - 1 && draft.inflight && serverState && JSON.stringify(draft.inflight) === JSON.stringify(serverState);
    return draft?.version === 1 && draft.project_id === projectId && (sameRevision || interruptedSave) && draft.state?.version === 1 ? draft.state : null;
  } catch {
    return null;
  }
}
