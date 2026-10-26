import { restoreFigure } from "./exportRestore";
import ExportDialog from "./components/ExportDialog";
import brandSymbol from "./assets/seiscanvas-symbol.svg?url";
import brandWordmark from "./assets/seiscanvas-wordmark.svg?url";
import ExportQueue from "./components/ExportQueue";
import ProjectMenu, { type ProjectAction } from "./components/ProjectMenu";
import HorizonMap from "./components/HorizonMap";
import { mapSelectionError } from "./components/horizonMapLogic";
import HorizonImportModal, {
  HorizonImportState,
} from "./components/HorizonImportModal";
import ServerFilesModal from "./components/ServerFilesModal";
import Sidebar from "./components/Sidebar";
import { SidebarStateProvider } from "./components/SidebarState";
import DataPanel, { ImportProgress } from "./components/panels/DataPanel";
import SectionPanel, { SectionNavigation } from "./components/panels/SectionPanel";
import SeismicPanel from "./components/panels/SeismicPanel";
import HorizonPanel from "./components/panels/HorizonPanel";
import HorizonOrganizationModal from "./components/HorizonOrganizationModal";
import { inheritLayerColors, layerColors, layerFromName, patchHorizon, suggestModel } from "./horizonOrganization";
import SectionPlot from "./components/SeismicViewer2D/SectionPlot";
import { useState, useEffect, useRef, useMemo } from "react";
import {
  Activity,
  Upload,
  Plus,
  RotateCcw,
  Layers,
  MousePointer2,
  Move,
  Check,
  X,
  LoaderCircle,
  Package,
  Save,
} from "lucide-react";

import {
  HS,
  SS,
  VS,
  Meta,
  ExportDialogSettings,
  ExportItem,
  MapProfileOverlay,
  defaultScene,
  makeSlice,
} from "./types";
import { api, json, getApiProject, setApiProject, waitForMutations } from "./api/client";
import { formatAmplitude } from "./format";
import { useOriginalProbe, ProbeReadout } from "./components/Probe";
import Scene3D, { Scene3DHandle } from "./components/SeismicViewer3D/Scene3D";
import {
  SliceManager,
  SceneControls,
  Export3DDialog,
} from "./components/SeismicViewer3D/Controls3D";
import { useExportQueue } from "./hooks/useExportQueue";
import { useWorkspacePersistence } from "./hooks/useWorkspacePersistence";
import { useModalFocus } from "./hooks/useModalFocus";
import { useSectionData } from "./hooks/useSectionData";
import { initialMapWorkspace, initialExport3D, reconcileMapWorkspace, restoreState, readDraft, draftTabId, projectDrafts, type DraftCandidate, type WorkspaceResponse, type WorkspaceState } from "./workspace";

/* -------------------------------------------------------------------------- */
/* Initial state                                                              */
/* -------------------------------------------------------------------------- */

const initial: VS = {
  view_mode: "2d",
  slices: {
    inline: [],
    crossline: [],
    time: [],
  },
  scene: defaultScene,

  view_type: "inline",
  section_number: 350,

  x_range: null,
  time_range: null,
  aspect_ratio_2d: null,

  seismic: {
    colormap: "seismic",
    reverse_colormap: false,

    clip_mode: "percentile",
    clip_percentile: 99.5,

    symmetric: true,

    vmin: -10000,
    vmax: 10000,

    reverse_polarity: false,

    wiggle: false,
    variable_area: false,
    wiggle_gain: 1,
    variable_area_color: "#000000",
    background_interpolation: true,
    wiggle_interpolation: true,

    // Compatibility with older saved workspaces.
    interpolation: "bilinear",
    adaptive_resolution: true,
  },

  smooth_horizons: false,
  horizon_sg: false,
  horizon_sg_window: 7,
  horizons: [],
};

const initialExport: ExportDialogSettings = {
  canvas: "fit",
  long_edge: 3000,
  background: "white",
  width: 180,
  height: 100,
  dpi: 300,

  font: "Times New Roman",
  font_size: 10,

  show_axes: true,
  show_labels: true,
  show_title: true,

  format: "png",

  // Scalar-map compatibility; seismic sections follow their display switches.
  interpolation: "bicubic",
  resolution: "export",
};

function loadedView(meta: Meta, horizons: HS[]): VS {
  const inline = meta.inlines[Math.floor(meta.inlines.length / 2)];
  const crossline = meta.crosslines[Math.floor(meta.crosslines.length / 2)];
  const time = meta.time_range[0] + Math.round((meta.samples - 1) / 2) * meta.sample_interval;
  return {
    ...initial, scene: structuredClone(defaultScene), horizons, section_number: inline,
    slices: { inline: [makeSlice(inline)], crossline: [makeSlice(crossline)], time: [makeSlice(time)] },
  };
}

/* -------------------------------------------------------------------------- */
/* App                                                                        */
/* -------------------------------------------------------------------------- */

function ProjectWorkspace({ initialProject, onActivate, bootstrapError = "" }: { initialProject: WorkspaceResponse; onActivate: (result: WorkspaceResponse) => void; bootstrapError?: string }) {
  /* ------------------------------------------------------------------------ */
  /* Refs                                                                     */
  /* ------------------------------------------------------------------------ */

  const sceneRef = useRef<Scene3DHandle>(null);
  const deleteDialog = useRef<HTMLDivElement>(null);

  /* ------------------------------------------------------------------------ */
  /* State                                                                    */
  /* ------------------------------------------------------------------------ */

  const [sceneReady, setSceneReady] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(
    null,
  );
  const [mapReady, setMapReady] = useState(false);

  const [meta, setMeta] = useState<Meta | null>(null);
  const [view, setView] = useState<VS>(initial);

  const viewRef = useRef(view);

  const [maps, setMaps] = useState<Record<string, any[]>>({});
  const [mapColors, setMapColors] = useState<Record<string, any[]>>({});

  const [busy, setBusy] = useState("正在恢复上次工作…");

  const [error, setError] = useState(bootstrapError);
  const [conflict, setConflict] = useState("");
  const [sidebarValues, setSidebarValues] = useState<Record<string, string | boolean>>(initialProject.state?.sidebarValues || {});
  const [sidebarScroll, setSidebarScroll] = useState<Record<string, number>>(initialProject.state?.sidebarScroll || {});
  const operation = useRef(false);
  const [notice, setNotice] = useState("");
  const [restoreUndo, setRestoreUndo] = useState<{ state: WorkspaceState; revision: number; filename: string; warnings: string[] } | null>(null);
  const restoreRequest = useRef<AbortController | null>(null);
  useEffect(() => () => restoreRequest.current?.abort(), []);

  const [geometryMode, setGeometryMode] = useState("auto");
  const [serverPathMode, setServerPathMode] = useState(false);
  const [serverFiles, setServerFiles] = useState<{ kind: string; multiple: boolean } | null>(null);
  const serverFilesResolve = useRef<((paths: string[] | null) => void) | null>(null);

  function selectServerFiles(kind: string, multiple = false): Promise<string[] | null | undefined> {
    if (!serverPathMode) return Promise.resolve(undefined);
    return new Promise(resolve => {
      serverFilesResolve.current = resolve;
      setServerFiles({ kind, multiple });
    });
  }

  function finishServerFiles(paths: string[] | null) {
    setServerFiles(null);
    serverFilesResolve.current?.(paths);
    serverFilesResolve.current = null;
  }
  const [bytes, setBytes] = useState({ il: 189, xl: 21 });

  const [selected, setSelected] = useState("");
  const [horizonToDelete, setHorizonToDelete] = useState<HS | null>(null);
  const [organizationOpen, setOrganizationOpen] = useState(false);
  const [mapControlsHost, setMapControlsHost] = useState<HTMLDivElement | null>(null);

  const [horizonImport, setHorizonImport] = useState<HorizonImportState | null>(
    null,
  );

  const [exportOpen, setExportOpen] = useState(false);
  const [settings, setSettings] = useState<ExportDialogSettings>(initialExport);
  const [settings3D, setSettings3D] = useState(initialExport3D);
  const [mapWorkspace, setMapWorkspace] = useState(initialMapWorkspace);
  const [project, setProject] = useState<WorkspaceResponse | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [draftChoices, setDraftChoices] = useState<DraftCandidate[]>([]);
  const pendingRecovery = useRef<WorkspaceResponse | null>(null);
  const draftsDialog = useRef<HTMLDivElement>(null);

  const [queueOpen, setQueueOpen] = useState(false);
  const [dataset, setDataset] = useState("");

  const [drag, setDrag] = useState<"zoom" | "pan">("zoom");

  const {
    reading: probe,
    probe: runProbe,
    reset: resetProbe,
  } = useOriginalProbe();

  const [revision, setRevision] = useState(0);
  const { section, loading, plotWrap, sectionViewportRef, measuredSectionViewport, resetSection } =
    useSectionData(meta, view, revision, setError);
  useModalFocus(deleteDialog, !!horizonToDelete, () => setHorizonToDelete(null), !busy);

  viewRef.current = view;

  const workspaceState = useMemo<WorkspaceState>(() => ({
    version: 1, view, map: mapWorkspace, settings, settings3D, dataset, selected,
    bytes, geometryMode, sidebar: true, drag, sidebarValues, sidebarScroll,
  }), [view, mapWorkspace, settings, settings3D, dataset, selected, bytes, geometryMode, drag, sidebarValues, sidebarScroll]);
  const persistence = useWorkspacePersistence(workspaceState, project, hydrated && !conflict, setError);
  const saveStatus = persistence.status;

  function applyRecovered(result: WorkspaceResponse, chosenDraft?: WorkspaceState | null) {
    setProject(result);
    if (!result.project_id) return;
    if (chosenDraft === undefined && !result.issues.length) {
      try {
        const candidates = projectDrafts(localStorage, result.project_id, result.revision, result.state);
        const unique = [...new Map(candidates.filter(d => d.compatible).map(d => [JSON.stringify(d.state), d])).values()];
        if (unique.length > 1 || candidates.some(d => !d.compatible)) {
          pendingRecovery.current = result;
          setDraftChoices(candidates);
          return;
        }
        if (unique.length === 1) chosenDraft = unique[0].state;
      } catch { /* Server state is available without browser storage. */ }
    }
    const defaults: WorkspaceState = {
      version: 1, view: result.metadata ? loadedView(result.metadata, result.horizons) : initial,
      map: initialMapWorkspace(), settings: initialExport, settings3D: initialExport3D,
      dataset: "", selected: result.horizons[0]?.id || "", sidebar: true, drag: "zoom",
      bytes: { il: result.source?.ilbyte || 189, xl: result.source?.xlbyte || 21 },
      geometryMode: result.source?.geometry_mode || "auto",
    };
    let draft: WorkspaceState | null = null;
    try { draft = chosenDraft === undefined ? readDraft(localStorage, result.project_id, result.revision, result.state, draftTabId()) : chosenDraft; } catch { /* Storage may be disabled. */ }
    const state = restoreState(defaults, result.issues.length ? result.state : draft || result.state, result.horizons);
    resetSection();
    setOrganizationOpen(false);
    setHorizonImport(null);
    setMeta(result.metadata);
    setView(result.metadata ? state.view : { ...state.view, view_mode: "2d" });
    setMapWorkspace(state.map);
    setSettings(state.settings);
    setSettings3D(state.settings3D);
    setDataset(state.dataset);
    setSelected(state.selected);
    setBytes(state.bytes);
    setGeometryMode(state.geometryMode);
    setDrag(state.drag);
    setSidebarValues(state.sidebarValues || {});
    setSidebarScroll(state.sidebarScroll || {});
    setRevision(v => v + 1);
    if (!result.issues.length && result.metadata) setNotice(result.notice || "已恢复项目");
  }

  useEffect(() => {
    applyRecovered(initialProject);
    if (!pendingRecovery.current) setHydrated(true);
    setBusy("");
  }, []);

  async function projectAction(action: ProjectAction) {
    if (operation.current) throw new Error("请等待当前操作完成。");
    operation.current = true;
    persistence.pause();
    setError("");
    setBusy("正在保存当前项目…");
    let committing = false;
    let intendedTarget = action.id;
    const origin = { ...getApiProject() };
    let preparedToken = "";
    const cancelling = () => setBusy("正在取消，等待数据读取结束…");
    action.signal?.addEventListener("abort", cancelling);
    try {
      if (!project?.issues.length && !conflict) await persistence.flush();
      await waitForMutations();
      action.signal?.throwIfAborted();
      if (action.type === "relink") {
        if (!action.relink?.path) {
          const paths = await selectServerFiles(action.relink?.horizon_id ? "层位" : "SEG-Y");
          if (paths === null) return { cancelled: true };
          if (paths) action = { ...action, relink: { ...action.relink!, path: paths[0] } };
        }
        setBusy("正在重新关联文件…");
        const result = await (await api(`/projects/${action.id}/relink`, json(action.relink))).json();
        if (result.project_id && action.relink?.confirm) onActivate(result);
        return result;
      }
      if (action.type === "rename") {
        const result = await (await api(`/projects/${project?.project_id}`, { ...json({ name: action.name }), method: "PATCH" })).json();
        setProject(p => p ? { ...p, name: result.name } : p);
        setNotice("项目已重命名");
        return;
      }
      let target = action.id;
      if (action.type === "create" || action.type === "clone") {
        setBusy("正在创建项目…");
        const result = await (await api("/projects", json({ name: action.name, request_id: action.requestId, template_id: action.type === "clone" ? project?.project_id : null }))).json();
        target = result.project_id;
      }
      intendedTarget = target;
      action.signal?.throwIfAborted();
      setBusy("正在读取项目数据…");
      const prepared = await (await api("/project-switches", json({ target_id: target, source_revision: getApiProject().project_id ? getApiProject().revision : null }))).json();
      preparedToken = prepared.token;
      if (action.signal?.aborted) {
        await api(`/project-switches/${prepared.token}`, { method: "DELETE" });
        action.signal.throwIfAborted();
      }
      setBusy("正在恢复项目视图…");
      action.onCommit?.();
      committing = true;
      const result = await (await api(`/project-switches/${prepared.token}/commit`, { method: "POST" })).json();
      onActivate(result);
    } catch (e) {
      // A lost commit response must be reconciled with the server's identity.
      if (committing) {
        const result = await api("/workspace").then(r => r.json()).catch(() => null);
        if (result?.project_id === intendedTarget) { onActivate(result); return; }
        if (result && (result.project_id !== origin.project_id || result.activation_epoch !== origin.activation_epoch)) {
          onActivate({ ...result, notice: "活动项目已在其他页面切换，已恢复服务端项目。" });
          return;
        }
        if (!result) setConflict("无法确认切换结果，请重新加载。");
        else if (preparedToken) await api(`/project-switches/${preparedToken}`, { method: "DELETE" }).catch(() => undefined);
      }
      throw e;
    } finally {
      action.signal?.removeEventListener("abort", cancelling);
      operation.current = false;
      persistence.resume();
      setBusy("");
    }
  }

  function relink(horizon_id: string | null) {
    void projectAction({ type: "relink", id: project?.project_id || "", relink: { horizon_id } }).then(async candidate => {
      if (!candidate || candidate.cancelled) return;
      // The project browser presents the candidate details and confirmation.
      setRecoveryCandidate({ horizon_id, ...candidate });
    }).catch(e => setError(e.message));
  }
  const [recoveryCandidate, setRecoveryCandidate] = useState<any>(null);
  function resolveDraft(draft: WorkspaceState | null) {
    const recovered = pendingRecovery.current;
    if (!recovered) return;
    try { for (const choice of draftChoices) localStorage.removeItem(choice.key); } catch { /* Still restore the selected state. */ }
    pendingRecovery.current = null;
    setDraftChoices([]);
    applyRecovered(recovered, draft);
    setHydrated(true);
  }
  useModalFocus(draftsDialog, !!draftChoices.length, () => resolveDraft(null));
  const recoveryDialog = useRef<HTMLDivElement>(null);
  useModalFocus(recoveryDialog, !!recoveryCandidate, () => setRecoveryCandidate(null), !busy);

  async function saveProject() {
    if (operation.current || !project?.project_id || conflict) return;
    await task("正在保存项目…", async () => { await persistence.flush(); setNotice("项目已保存"); });
  }
  const saveProjectRef = useRef(saveProject);
  saveProjectRef.current = saveProject;
  useEffect(() => {
    const saveKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!document.querySelector('[aria-modal="true"]')) void saveProjectRef.current();
      }
    };
    const changed = (event: Event) => { persistence.pause(); setConflict((event as CustomEvent).detail.message); };
    window.addEventListener("keydown", saveKey);
    window.addEventListener("seiscanvas-project-conflict", changed);
    return () => { window.removeEventListener("keydown", saveKey); window.removeEventListener("seiscanvas-project-conflict", changed); };
  }, []);

  /* ------------------------------------------------------------------------ */
  /* Load colormaps                                                           */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    api("/catalog")
      .then((r) => r.json())
      .then((c) => { setMaps(c.colormaps); setMapColors(c.map_colormaps || c.colormaps); setServerPathMode(!!c.server_path_mode); })
      .catch((e) => setError(e.message));
  }, []);

  /* ------------------------------------------------------------------------ */
  /* Notice                                                                   */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    if (!notice) return;

    const t = setTimeout(() => {
      setNotice("");
    }, 4500);

    return () => clearTimeout(t);
  }, [notice]);

  /* ------------------------------------------------------------------------ */
  /* Generic task                                                             */
  /* ------------------------------------------------------------------------ */

  async function task(label: string, fn: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(label);
    setError("");

    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      operation.current = false;
      persistence.resume();
      setBusy("");
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Export queue                                                             */
  /* ------------------------------------------------------------------------ */

  const {
    items: queue,
    sessionId: queueSession,
    submitJob,
    jobs: exportJobs,
    submitting: submittingExport,
    activeJobCount,
    pendingJobIds,
    cancelJob,
    retryJob,
    rename: renameQueueItem,
    remove: deleteQueueItem,
    clear: clearQueue,
    exportItems,
    restoreSettings,
  } = useExportQueue({ task, notify: setNotice, onError: setError });

  function applyFigurePresentation(state: WorkspaceState) {
    resetSection();
    setView(state.view);
    setMapWorkspace(state.map);
    setSettings(state.settings);
    setSettings3D(state.settings3D);
    setExportOpen(false);
    setRevision(v => v + 1);
  }

  async function restoreQueueItem(item: ExportItem) {
    if (!meta || conflict || project?.issues.length) return;
    await task("正在恢复图件设置…", async () => {
      const owner = getApiProject();
      const controller = new AbortController();
      restoreRequest.current?.abort();
      restoreRequest.current = controller;
      const snapshot = await restoreSettings(item, controller.signal);
      if (controller.signal.aborted || getApiProject() !== owner) return;
      const next = restoreFigure(workspaceState, snapshot, meta);
      setRestoreUndo({ state: structuredClone(workspaceState), revision: revision + 1, filename: item.filename, warnings: snapshot.warnings });
      applyFigurePresentation(next);
      setQueueOpen(false);
    });
  }

  function undoFigureRestore() {
    if (!restoreUndo || restoreUndo.revision !== revision || busy || conflict) return;
    applyFigurePresentation(restoreUndo.state);
    setRestoreUndo(null);
    setNotice("已撤销图件设置恢复");
  }

  /* ------------------------------------------------------------------------ */
  /* Dataset loaded                                                           */
  /* ------------------------------------------------------------------------ */

  function loaded(result: WorkspaceResponse) {
    onActivate(result);
  }

  /* ------------------------------------------------------------------------ */
  /* Dataset name                                                             */
  /* ------------------------------------------------------------------------ */

  const datasetPlaceholder = meta
    ? meta.filename.replace(/\.[^.]+$/, "")
    : "Dataset";

  /* ------------------------------------------------------------------------ */
  /* Load example                                                             */
  /* ------------------------------------------------------------------------ */

  function loadExample() {
    task("加载 F3 示例数据…", async () => {
      await persistence.flush();
      persistence.pause();
      const r = await api(`/example?ilbyte=${bytes.il}&xlbyte=${bytes.xl}`, {
        method: "POST",
      });

      loaded(await r.json());
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Open SEG-Y from the local disk                                           */
  /* ------------------------------------------------------------------------ */

  function openSegy() {
    task("正在导入 SEG-Y…", async () => {
      const paths = await selectServerFiles("SEG-Y");
      if (paths === null) return;
      await persistence.flush();
      persistence.pause();
      const job_id = crypto.randomUUID();
      setImportProgress({
        percent: 0,
        stage: paths ? "正在读取服务器文件" : "请在系统窗口选择文件",
        status: "waiting",
      });
      let active = true;
      let timer: ReturnType<typeof setTimeout>;
      const poll = async () => {
        try {
          const r = await api(`/segy/progress/${job_id}`);
          const p = await r.json();
          if (active) setImportProgress(p);
        } catch {
          /* The import request reports failures. */
        }
        if (active) timer = setTimeout(poll, 600);
      };
      timer = setTimeout(poll, 300);
      try {
        const r = await api(
          "/segy/pick",
          json({
            job_id,
            path: paths?.[0],
            ilbyte: bytes.il,
            xlbyte: bytes.xl,
            geometry_mode: geometryMode,
          }),
        );
        const result = await r.json();
        active = false;
        if (!result.cancelled) {
          loaded(result);
          setImportProgress({
            percent: 100,
            stage: "导入完成",
            status: "done",
          });
        } else setImportProgress(null);
      } catch (e) {
        active = false;
        setImportProgress(null);
        throw e;
      } finally {
        active = false;
        clearTimeout(timer);
      }
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Upload horizons                                                          */
  /* ------------------------------------------------------------------------ */

  function uploadHorizons() {
    task("读取层位列…", async () => {
      const paths = await selectServerFiles("层位", true);
      if (paths === null) return;
      const preview = await (
        await api("/horizons/pick", paths ? json({ paths }) : { method: "POST" })
      ).json();
      if (preview.cancelled) return;

      const model = suggestModel(preview.filenames);
      const known = layerColors(viewRef.current.horizons);
      setHorizonImport({
        token: preview.token,
        filename: preview.filename,
        filenames: preview.filenames,
        columns: preview.columns,
        rows: preview.rows,
        inline_column: preview.suggestions.inline,
        xline_column: preview.suggestions.xline,
        time_column: preview.suggestions.time,
        model_group: model,
        horizon_keys: preview.filenames.map((name: string) => {
          const key = layerFromName(name, model);
          return known.has(key) ? key : "";
        }),
      });
    });
  }

  function importHorizon() {
    if (!horizonImport) return;

    task("加载层位…", async () => {
      const hs = await (
        await api(
          "/horizons/local",
          json({
            token: horizonImport.token,
            inline_column: horizonImport.inline_column,
            xline_column: horizonImport.xline_column,
            time_column: horizonImport.time_column,
            model_group: horizonImport.model_group,
            horizon_keys: horizonImport.horizon_keys,
          }),
        )
      ).json();

      setView((v) => ({
        ...v,
        horizons: [...v.horizons, ...inheritLayerColors(v.horizons, hs)],
      }));

      setSelected(hs[0].id);

      setRevision((v) => v + 1);
      setHorizonImport(null);
    });
  }

  function renameHorizon(h: HS, name: string) {
    task("修改层位名…", async () => {
      const result = await (
        await api(`/horizons/${h.id}`, {
          ...json({ name }),
          method: "PATCH",
        })
      ).json();
      setView((v) => ({
        ...v,
        horizons: v.horizons.map((a) =>
          a.id === h.id ? { ...a, name: result.name } : a,
        ),
      }));
      setRevision((v) => v + 1);
    });
  }

  function deleteHorizon(h: HS) {
    task("删除层位…", async () => {
      await api(`/horizons/${h.id}`, { method: "DELETE" });
      const remaining = viewRef.current.horizons.filter(a => a.id !== h.id);
      const next = remaining[Math.min(viewRef.current.horizons.findIndex(a => a.id === h.id), remaining.length - 1)]?.id || remaining[0]?.id || "";
      setView((v) => ({
        ...v,
        horizons: v.horizons.filter((a) => a.id !== h.id),
        view_mode: v.view_mode === "map" && !remaining.length ? "2d" : v.view_mode,
      }));
      setSelected(current => current === h.id ? next : current);
      setMapWorkspace(current => reconcileMapWorkspace(current, remaining));
      setHorizonToDelete(null);
      setExportOpen(false);
      setRevision(v => v + 1);
      setNotice(`已移除层位 ${h.name}`);
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Sections                                                                 */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    resetProbe();
  }, [view.view_type, view.section_number]);

  const sections = meta
    ? view.view_type === "inline"
      ? meta.inlines
      : meta.crosslines
    : [];

  function changeSection(n: number) {
    if (!sections.length) return;

    const nearest = sections.reduce((a, b) =>
      Math.abs(b - n) < Math.abs(a - n) ? b : a,
    );

    setView((v) => ({
      ...v,
      section_number: nearest,
      x_range: null,
      time_range: null,
    }));
    return nearest;
  }

  function changeMode(mode: "inline" | "crossline") {
    if (mode === view.view_type) return;

    const list = meta
      ? mode === "inline"
        ? meta.inlines
        : meta.crosslines
      : [];

    setView((v) => ({
      ...v,
      view_type: mode,
      section_number: list[Math.floor(list.length / 2)] || 0,
      x_range: null,
      time_range: null,
    }));
  }

  useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      if (view.view_mode !== "2d" || busy || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (document.querySelector('[aria-modal="true"]') ||
          (event.target instanceof HTMLElement && event.target.closest('input, select, textarea, [contenteditable="true"]'))) return;
      const index = sections.indexOf(view.section_number);
      if (index < 0) return;
      event.preventDefault();
      const next = sections[index + (event.key === "ArrowRight" ? 1 : -1)];
      if (next !== undefined) changeSection(next);
    };
    window.addEventListener("keydown", navigate);
    return () => window.removeEventListener("keydown", navigate);
  }, [sections, view.section_number, view.view_mode, busy]);

  /* ------------------------------------------------------------------------ */
  /* Seismic                                                                  */
  /* ------------------------------------------------------------------------ */

  function seismic(p: Partial<SS>) {
    setView((v) => ({
      ...v,
      seismic: {
        ...v.seismic,
        ...p,
      },
    }));
  }

  /* ------------------------------------------------------------------------ */
  /* Horizon style                                                            */
  /* ------------------------------------------------------------------------ */

  function style(p: Partial<HS>, id: string) {
    setView((v) => ({
      ...v,
      horizons: patchHorizon(v.horizons, id, p),
    }));
  }

  /* ------------------------------------------------------------------------ */
  /* Colormap preview                                                         */
  /* ------------------------------------------------------------------------ */

  const colors = maps[view.seismic.colormap] || [];

  const preview = useMemo(() => {
    const values = (
      view.seismic.reverse_colormap ? [...colors].reverse() : colors
    )
      .filter((_, i) => i % 16 === 0)
      .map((c) => c[1])
      .join(",");

    return `linear-gradient(90deg,${values})`;
  }, [colors, view.seismic.reverse_colormap]);

  /* ------------------------------------------------------------------------ */
  /* Submit fixed figure settings to the background export queue             */
  /* ------------------------------------------------------------------------ */

  async function add2DToQueue() {
    try {
      const job = await submitJob({
        kind: "2d", dataset,
        state: {
          ...view,
          trace_viewport_width: sectionViewportRef.current?.width ?? null,
          trace_viewport_height: sectionViewportRef.current?.height ?? null,
        },
        settings,
      });
      if (job) setExportOpen(false);
    } catch {
      // The queue hook displays the error; keep settings open for another try.
    }
  }

  async function add3DToQueue(settings3D: any) {
    setExportOpen(false);
    await task("正在保存三维图件…", async () => {
      const exportStarted = performance.now();
      if (!sceneRef.current) throw new Error("三维场景未就绪");
      const capture = await sceneRef.current.captureFigure(settings3D, setBusy);
      setBusy("正在提交三维图件…");
      await submitJob({
        kind: "3d",
        dataset,
        png: capture.png,
        format: capture.format,
        width_px: capture.width_px,
        height_px: capture.height_px,
        scale: capture.scale,
        render_dpi: capture.render_dpi,
        timings: capture.timings,
        vector_overlay: capture.vector_overlay,
        settings: settings3D,
        // Export uses the current cached textures and actual renderer camera.
        state: {
          ...view,
          scene: { ...view.scene, camera: capture.camera },
        },
      });
      console.info("SeisCanvas 3D Add to Export total " + JSON.stringify({
        total: performance.now() - exportStarted, format: capture.format,
      }));
    });
  }

  async function addMapToQueue(payload: { state: unknown; settings: unknown; profile: MapProfileOverlay | null }) {
    await submitJob({
      kind: "map",
      dataset,
      state: payload.state,
      settings: payload.settings,
      profile: payload.profile,
    });
  }

  async function addProfileToQueue(
    payload: Record<string, unknown> & { settings: unknown },
  ) {
    await submitJob({ kind: "profile", dataset, ...payload });
  }

  /* ------------------------------------------------------------------------ */
  /* Render                                                                   */
  /* ------------------------------------------------------------------------ */

  return (
    <SidebarStateProvider scope={view.view_mode} values={sidebarValues} onChange={setSidebarValues}>
    <div className="app">
      {/* ------------------------------------------------------------------ */}
      {/* Top bar                                                            */}
      {/* ------------------------------------------------------------------ */}

      <header className="topbar">
        <div className="brand">
          <img
            className="brand-mark"
            src={brandSymbol}
            alt=""
            width={44}
            height={44}
          />

          <img
            className="brand-wordmark"
            src={brandWordmark}
            alt="SeisCanvas"
            width={140}
            height={24}
          />

          <span className="version">V0.3</span>
        </div>

        <ProjectMenu project={project} disabled={!!busy || !!conflict} onAction={projectAction}/>

        <div className="top-status">
          <span className="status-dot" />
          {serverPathMode ? "远程" : "本地"}
          <span className="autosave-status" role="status">
            {busy === "正在恢复上次工作…" ? "恢复中…" : project?.issues.length ? "恢复待处理" : saveStatus === "saving" ? "保存中…" : saveStatus === "saved" ? "已保存" : saveStatus === "error" ? "保存失败" : saveStatus === "dirty" ? "有未保存更改" : ""}
          </span>
        </div>

        <button className="secondary project-save-button" disabled={!project?.project_id || !!busy || !!conflict || !!project.issues.length} onClick={() => void saveProject()} title="保存项目（Ctrl / ⌘ + S）"><Save size={15}/>{saveStatus === "error" ? "重试保存" : "保存项目"}</button>

        <button
          className="primary"
          disabled={
            !meta ||
            !!busy ||
            submittingExport ||
            (view.view_mode === "2d"
              ? loading
              : view.view_mode === "map"
                ? !mapReady || !!mapSelectionError(mapWorkspace.state, view.horizons)
                : !sceneReady)
          }
          onClick={() => setExportOpen(true)}
        >
          <Plus size={15} />
          保存图件
        </button>

        <button
          className="secondary queue-button"
          onClick={() => setQueueOpen(true)}
          title="导出队列"
        >
          <Package size={15} />
          导出队列 · {queue.length}
          {activeJobCount > 0 && <span className="queue-active-count">{activeJobCount} 生成中</span>}
        </button>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Workspace                                                          */}
      {/* ------------------------------------------------------------------ */}

      {!!project?.issues.length && <div className="project-recovery-banner" role="alert">{project.issues.map((issue, index) => <div key={index}><span>{issue.message}</span><button className="secondary" disabled={!!busy} onClick={() => relink(issue.horizon_id)}>重新关联…</button></div>)}</div>}

      <div className={`workspace${view.view_mode === "map" ? " map-workspace" : ""}`} inert={!!busy || !!conflict || !!project?.issues.length}>
        {/* ---------------------------------------------------------------- */}
        {/* Sidebar                                                          */}
        {/* ---------------------------------------------------------------- */}

          <Sidebar key={revision} scope={view.view_mode} savedPositions={sidebarScroll} onPosition={(scope, position) => setSidebarScroll(s => s[scope] === position ? s : { ...s, [scope]: position })} switcher={
              <div className="view-mode-switch segmented" role="group" aria-label="视图模式">
                {(["2d", "3d", "map"] as const).map(mode => (
                  <button
                    key={mode}
                    disabled={!!busy || (mode !== "2d" && !meta) || (mode === "map" && !view.horizons.length)}
                    title={busy ? busy : mode !== "2d" && !meta ? "导入 SEG-Y 后可用" : mode === "map" && !view.horizons.length ? "导入层位后可用" : undefined}
                    className={view.view_mode === mode ? "active" : ""}
                    aria-pressed={view.view_mode === mode}
                    onClick={() => { setExportOpen(false); setView(v => ({ ...v, view_mode: mode })); }}
                  >
                    {mode === "map" ? "层位地图" : mode.toUpperCase()}
                  </button>
                ))}
              </div>
            }>
            <DataPanel
              datasetName={dataset || datasetPlaceholder}
              progress={importProgress}
              busy={busy}
              onOpenSegy={openSegy}
              onLoadExample={loadExample}
              geometryMode={geometryMode}
              onGeometryMode={setGeometryMode}
              bytes={bytes}
              onBytes={setBytes}
              meta={meta}
            />

            {/* ------------------------------------------------------------ */}
            {/* 2D / 3D / Map                                                */}
            {/* ------------------------------------------------------------ */}

            <div id="horizon-map-controls" ref={setMapControlsHost} />
            {view.view_mode === "3d" && meta && (
              <>
                <SliceManager
                  key={meta.filename + revision}
                  meta={meta}
                  slices={view.slices}
                  disabled={!!busy}
                  onChange={(slices) => setView((v) => ({ ...v, slices }))}
                />

              </>
            )}

            {meta && view.view_mode === "2d" && (
              <SectionPanel
                view={view}
                sections={sections}
                busy={busy}
                meta={meta}
                onMode={changeMode}
                onSection={changeSection}
                onPatch={setView}
              />
            )}

            {meta && view.view_mode !== "map" && (
              <SeismicPanel
                key={view.view_mode}
                view={view}
                maps={maps}
                onSeismic={seismic}
              />
            )}

            {meta && (
              <HorizonPanel
                view={view}
                selected={selected}
                onSelect={setSelected}
                busy={busy}
                meta={meta}
                onStyle={style}
                onPatch={setView}
                onRename={renameHorizon}
                onDelete={h => { setError(""); setHorizonToDelete(h); }}
                onAdd={uploadHorizons}
                onOrganize={() => setOrganizationOpen(true)}
              />
            )}

            {meta && view.view_mode === "3d" && (
              <SceneControls
                scene={view.scene}
                onChange={(scene) => setView((v) => ({ ...v, scene }))}
              />
            )}
          </Sidebar>

        {/* ---------------------------------------------------------------- */}
        {/* Main                                                             */}
        {/* ---------------------------------------------------------------- */}

        <main>

          {error && (
            <div role="alert" className="error">
              <span>{error}</span>

              <button className="icon" onClick={() => setError("")}>
                <X size={14} />
              </button>
            </div>
          )}

          {view.view_mode === "map" ? (
            <HorizonMap key={revision}
              controlsHost={mapControlsHost}
              workspace={mapWorkspace}
              onWorkspace={setMapWorkspace}
              horizons={view.horizons}
              maps={maps}
              mapColors={mapColors}
              seismic={view.seismic}
              onSeismic={seismic}
              onAddProfileToExport={addProfileToQueue}
              exportOpen={exportOpen}
              onCloseExport={() => setExportOpen(false)}
              onReady={setMapReady}
              dataset={dataset}
              datasetPlaceholder={datasetPlaceholder}
              onDataset={setDataset}
              onAddToExport={addMapToQueue}
            />
          ) : view.view_mode === "3d" && meta ? (
            <Scene3D
              busy={busy}
              ref={sceneRef}
              view={view}
              meta={meta}
              maps={maps}
              revision={revision}
              onReady={setSceneReady}
              onError={setError}
              onCamera={(camera) =>
                setView((v) => ({
                  ...v,
                  scene: {
                    ...v.scene,
                    camera,
                  },
                }))
              }
            />
          ) : (
            <>
              {/* ---------------------------------------------------------- */}
              {/* 2D viewer                                                  */}
              {/* ---------------------------------------------------------- */}

              <div className="viewer-card">
                <div className="viewer-toolbar">
                  <b>{meta ? `${view.view_type === "inline" ? "Inline" : "Crossline"} ${view.section_number}` : "二维剖面"}</b>

                  {meta && <SectionNavigation sections={sections} value={view.section_number}
                    disabled={!!busy} onChange={changeSection} />}

                  <div className="tools">
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
                      disabled={!meta}
                      onClick={() =>
                        setView((v) => ({
                          ...v,
                          x_range: null,
                          time_range: null,
                        }))
                      }
                    >
                      <RotateCcw size={14} />
                      重置
                    </button>
                  </div>
                </div>

                <div className="plot-wrap" ref={plotWrap}>
                  {section ? (
                    <SectionPlot
                      meta={meta}
                      view={view}
                      section={section}
                      colors={colors}
                      drag={drag}
                      onPatch={setView}
                      onProbe={runProbe}
                      onError={setError}
                      onViewportSize={measuredSectionViewport}
                    />
                  ) : !busy && !loading ? (
                    <div className="empty">
                      <div className="empty-icon">
                        <Activity size={32} strokeWidth={1.5} />
                      </div>

                      <h2>{project?.name || "暂无地震数据"}</h2>

                      <div className="empty-actions">
                        <button
                          className="primary"
                          disabled={!!busy}
                          onClick={openSegy}
                        >
                          <Upload size={15} />
                          导入 SEG-Y
                        </button>

                        <button
                          className="secondary"
                          disabled={!!busy}
                          onClick={loadExample}
                        >
                          <Layers size={15} />
                          加载示例
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {(busy || loading) && (
                    <div className="loading">
                      <LoaderCircle className="spin" size={17} />
                      {busy || "提取剖面…"}
                    </div>
                  )}
                </div>

                <div className="viewer-bottom">
                  <ProbeReadout reading={probe} />

                  <div className="legend">
                    {view.horizons
                      .filter((h) => h.visible)
                      .map((h) => (
                        <span key={h.id}>
                          <i style={{ background: h.color }} />
                          {h.name}
                        </span>
                      ))}
                  </div>

                  {section && (
                    <div className="amplitude-key">
                      <span>{formatAmplitude(section.vmin)}</span>

                      <i style={{ background: preview }} />

                      <span>{formatAmplitude(section.vmax)}</span>

                      <b>振幅</b>
                    </div>
                  )}
                </div>
              </div>

              <div className="canvas-footer">
                {meta ? (
                  <span>
                    {view.view_type === "inline"
                      ? `Crossline ${meta.crosslines[0]}–${meta.crosslines.at(-1)}`
                      : `Inline ${meta.inlines[0]}–${meta.inlines.at(-1)}`}
                    <span className="dot-separator">·</span>
                    Time {meta.time_range[0]}–{meta.time_range[1]} ms
                  </span>
                ) : (
                  <span>未加载数据</span>
                )}
              </div>
            </>
          )}
        </main>
      </div>

      {persistence.draftWarning && <div className="project-switch-progress" role="status">{persistence.draftWarning}</div>}
      {conflict && <div className="project-conflict" role="alert"><span>{conflict}</span><button className="secondary" onClick={() => window.location.reload()}>重新加载</button></div>}
      {busy && busy !== "正在恢复上次工作…" && <div className="project-switch-progress" role="status"><LoaderCircle className="spin" size={16}/>{busy}</div>}
      {!!draftChoices.length && <div className="modal-backdrop project-backdrop"><div className="modal project-dialog" ref={draftsDialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="drafts-title">
        <h2 id="drafts-title">恢复草稿</h2>
        <div className="project-draft-choices">{draftChoices.map((draft, index) => <div key={draft.key}><span>草稿 {index + 1} · {draft.updated_at ? new Date(draft.updated_at).toLocaleString() : `版本 ${draft.revision}`}<small>{draft.compatible ? "可恢复" : "与当前版本冲突"}</small></span><button className="secondary" onClick={() => {
          const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = `SeisCanvas-draft-${index + 1}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}>下载</button>{draft.compatible && <button className="primary" onClick={() => resolveDraft(draft.state)}>恢复</button>}</div>)}</div>
        <div className="project-actions"><button className="secondary" onClick={() => resolveDraft(null)}>使用已保存版本</button></div>
      </div></div>}
      {recoveryCandidate && <div className="modal-backdrop project-backdrop"><div className="modal project-dialog" ref={recoveryDialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="recovery-title">
        <h2 id="recovery-title">确认重新关联文件</h2><dl className="project-detail"><dt>原文件</dt><dd>{recoveryCandidate.previous_path}</dd><dt>新文件</dt><dd>{recoveryCandidate.path}</dd></dl>{recoveryCandidate.horizon_id === null && <p>剖面范围和切片位置将重置。</p>}
        <div className="project-actions"><button className="secondary" disabled={!!busy} onClick={() => setRecoveryCandidate(null)}>取消</button><button className="primary" disabled={!!busy} onClick={() => { void projectAction({ type: "relink", id: project?.project_id || "", relink: { horizon_id: recoveryCandidate.horizon_id, path: recoveryCandidate.path, revision: recoveryCandidate.revision, file_identity: recoveryCandidate.file_identity, confirm: true } }).then(() => setRecoveryCandidate(null)).catch(e => setError(e.message)); }}>确认关联</button></div>
      </div></div>}

      {/* ------------------------------------------------------------------ */}
      {/* Toast                                                              */}
      {/* ------------------------------------------------------------------ */}

      {restoreUndo && restoreUndo.revision === revision && (
        <div className="restore-notice" role="status">
          <span>已恢复 {restoreUndo.filename}{restoreUndo.warnings.length > 0 && <small>{restoreUndo.warnings.join(" ")}</small>}</span>
          <button className="secondary" disabled={!!busy || !!conflict} onClick={undoFigureRestore}>撤销本次恢复</button>
          <button className="icon" aria-label="关闭恢复提示" onClick={() => setRestoreUndo(null)}><X size={16} /></button>
        </div>
      )}
      {notice && (
        <div className="toast">
          <Check size={16} />
          {notice}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* 3D export                                                          */}
      {/* ------------------------------------------------------------------ */}

      {exportOpen && view.view_mode === "3d" && (
        <Export3DDialog
          settings={settings3D}
          onSettings={setSettings3D}
          busy={busy}
          error={error}
          dataset={dataset}
          datasetPlaceholder={datasetPlaceholder}
          onDataset={setDataset}
          onClose={() => setExportOpen(false)}
          onExport={add3DToQueue}
        />
      )}

      {/* ------------------------------------------------------------------ */}
      {/* 2D export                                                          */}
      {/* ------------------------------------------------------------------ */}

      {exportOpen && view.view_mode === "2d" && (
        <ExportDialog
          title="二维剖面 · 保存图件"
          settings={settings}
          onChange={(p) => setSettings((s) => ({ ...s, ...p }))}
          onClose={() => setExportOpen(false)}
          onExport={add2DToQueue}
          dataset={dataset}
          datasetPlaceholder={datasetPlaceholder}
          onDataset={setDataset}
          busy={!!busy || submittingExport}
          disabled={loading}
          error={error}
        />
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Export queue                                                       */}
      {/* ------------------------------------------------------------------ */}

      <ExportQueue
        projectId={project?.project_id}
        open={queueOpen}
        items={queue}
        jobs={exportJobs}
        pendingJobIds={pendingJobIds}
        onCancelJob={cancelJob}
        onRetryJob={retryJob}
        session={queueSession}
        busy={!!busy}
        onClose={() => setQueueOpen(false)}
        onRename={renameQueueItem}
        onDelete={deleteQueueItem}
        onClear={clearQueue}
        onExport={exportItems}
        onRestore={restoreQueueItem}
        error={error}
      />

      {serverFiles && <ServerFilesModal {...serverFiles} onDone={finishServerFiles} />}

      {horizonImport && (
        <HorizonImportModal
          state={horizonImport}
          busy={busy}
          onClose={() => setHorizonImport(null)}
          onColumn={(key, value) =>
            setHorizonImport((current) =>
              current ? { ...current, [key]: value } : current,
            )
          }
          onImport={importHorizon}
          horizons={view.horizons}
          onOrganization={patch => setHorizonImport(current => current ? { ...current, ...patch } : current)}
        />
      )}

      {organizationOpen && <HorizonOrganizationModal key={project?.project_id} horizons={view.horizons}
        onClose={() => setOrganizationOpen(false)} onApply={organized => {
          const updates = new Map(organized.map(h => [h.id, h]));
          setView(current => ({ ...current, horizons: current.horizons.map(h => {
            const updated = updates.get(h.id);
            return updated ? { ...h, model_group: updated.model_group, horizon_key: updated.horizon_key, color: updated.color } : h;
          }) }));
          setOrganizationOpen(false);
          setNotice("已更新模型分组、层位对应关系和统一配色。");
        }} />}

      {horizonToDelete && (
        <div className="modal-backdrop" onClick={() => !busy && setHorizonToDelete(null)}>
          <div ref={deleteDialog} tabIndex={-1} className="modal delete-horizon-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-horizon-title" onClick={e => e.stopPropagation()}>
            <h2 id="delete-horizon-title">移除层位 {horizonToDelete.name}？</h2>
            {mapWorkspace.state.color_by === "difference" && (mapWorkspace.state.difference_reference === horizonToDelete.id || mapWorkspace.state.difference_comparison === horizonToDelete.id) && (
              <p className="delete-horizon-impact">差值计算需重新选择层位。</p>
            )}
            {error && <p className="error" role="alert">{error}</p>}
            <div className="import-actions">
              <button className="secondary" disabled={!!busy} onClick={() => setHorizonToDelete(null)}>取消</button>
              <button className="danger-button" disabled={!!busy} onClick={() => deleteHorizon(horizonToDelete)}>{busy ? "正在移除…" : "确认移除"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
    </SidebarStateProvider>
  );
}


const emptyProject: WorkspaceResponse = { project_id: null, revision: 0, metadata: null, horizons: [], state: null, issues: [] };

/** The shell owns activation; each project gets a fresh component tree. */
export default function App() {
  const [active, setActive] = useState<WorkspaceResponse | null>(null);
  const [generation, setGeneration] = useState(0);
  const [startupError, setStartupError] = useState("");
  function activate(result: WorkspaceResponse) {
    setApiProject(result);
    setActive(result);
    setGeneration(n => n + 1);
  }
  useEffect(() => {
    let alive = true;
    api("/workspace").then(r => r.json()).then(result => { if (alive) activate(result); })
      .catch(e => { if (alive) { setStartupError("恢复失败：" + e.message); activate(emptyProject); } });
    return () => { alive = false; };
  }, []);
  if (!active) return <div className="project-switch-progress" role="status"><LoaderCircle size={18} className="spin"/>正在恢复上次项目…</div>;
  return <ProjectWorkspace key={`${active.project_id}:${active.activation_epoch}:${generation}`} initialProject={active} onActivate={activate} bootstrapError={startupError}/>;
}
