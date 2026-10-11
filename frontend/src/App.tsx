import ExportDialog from "./components/ExportDialog";
import ExportQueue from "./components/ExportQueue";
import HorizonMap from "./components/HorizonMap";
import { mapSelectionError } from "./components/horizonMapLogic";
import HorizonImportModal, {
  HorizonImportState,
} from "./components/HorizonImportModal";
import DataPanel, { ImportProgress } from "./components/panels/DataPanel";
import SectionPanel, { SectionNavigation } from "./components/panels/SectionPanel";
import SeismicPanel from "./components/panels/SeismicPanel";
import HorizonPanel from "./components/panels/HorizonPanel";
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
  PanelLeftClose,
  PanelLeftOpen,
  Package,
} from "lucide-react";

import {
  HS,
  SS,
  VS,
  Meta,
  Section,
  ExportDialogSettings,
  defaultScene,
  makeSlice,
} from "./types";
import { api, json } from "./api/client";
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
import { initialMapWorkspace, initialExport3D, reconcileMapWorkspace, restoreState, readDraft, type WorkspaceResponse, type WorkspaceState } from "./workspace";

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

    // Interactive browsing defaults: bilinear at viewport resolution.
    interpolation: "bilinear",
    adaptive_resolution: true,
  },

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

  // Publication defaults: bicubic at the export resolution.
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

export default function App() {
  /* ------------------------------------------------------------------------ */
  /* Refs                                                                     */
  /* ------------------------------------------------------------------------ */

  const sceneRef = useRef<Scene3DHandle>(null);
  const plotWrap = useRef<HTMLDivElement>(null);
  const deleteDialog = useRef<HTMLDivElement>(null);

  const requestId = useRef(0);

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
  const [section, setSection] = useState<Section | null>(null);

  const viewRef = useRef(view);

  const [maps, setMaps] = useState<Record<string, any[]>>({});
  const [mapColors, setMapColors] = useState<Record<string, any[]>>({});

  const [busy, setBusy] = useState("正在恢复上次工作…");
  const [loading, setLoading] = useState(false);

  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [geometryMode, setGeometryMode] = useState("auto");
  const [bytes, setBytes] = useState({ il: 189, xl: 21 });

  const [selected, setSelected] = useState("");
  const [horizonToDelete, setHorizonToDelete] = useState<HS | null>(null);
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

  const [queueOpen, setQueueOpen] = useState(false);
  const [dataset, setDataset] = useState("");

  const [drag, setDrag] = useState<"zoom" | "pan">("zoom");

  const {
    reading: probe,
    probe: runProbe,
    reset: resetProbe,
  } = useOriginalProbe();

  const [sidebar, setSidebar] = useState(true);

  const [revision, setRevision] = useState(0);
  useModalFocus(deleteDialog, !!horizonToDelete, () => setHorizonToDelete(null), !busy);

  viewRef.current = view;

  const workspaceState = useMemo<WorkspaceState>(() => ({
    version: 1, view, map: mapWorkspace, settings, settings3D, dataset, selected,
    bytes, geometryMode, sidebar, drag,
  }), [view, mapWorkspace, settings, settings3D, dataset, selected, bytes, geometryMode, sidebar, drag]);
  const saveStatus = useWorkspacePersistence(workspaceState, project, hydrated, setError);

  function applyRecovered(result: WorkspaceResponse) {
    setProject(result);
    if (!result.project_id) return;
    const defaults: WorkspaceState = {
      version: 1, view: result.metadata ? loadedView(result.metadata, result.horizons) : initial,
      map: initialMapWorkspace(), settings: initialExport, settings3D: initialExport3D,
      dataset: "", selected: result.horizons[0]?.id || "", sidebar: true, drag: "zoom",
      bytes: { il: result.source?.ilbyte || 189, xl: result.source?.xlbyte || 21 },
      geometryMode: result.source?.geometry_mode || "auto",
    };
    let draft: WorkspaceState | null = null;
    try { draft = readDraft(localStorage, result.project_id, result.revision, result.state); } catch { /* Storage may be disabled. */ }
    const state = restoreState(defaults, result.issues.length ? result.state : draft || result.state, result.horizons);
    requestId.current++;
    setSection(null);
    setMeta(result.metadata);
    setView(result.metadata ? state.view : { ...state.view, view_mode: "2d" });
    setMapWorkspace(state.map);
    setSettings(state.settings);
    setSettings3D(state.settings3D);
    setDataset(state.dataset);
    setSelected(state.selected);
    setBytes(state.bytes);
    setGeometryMode(state.geometryMode);
    setSidebar(state.sidebar);
    setDrag(state.drag);
    setRevision(v => v + 1);
    if (!result.issues.length) setNotice("已恢复上次工作");
  }

  useEffect(() => {
    let active = true;
    api("/workspace")
      .then(r => r.json())
      .then(result => { if (active) { applyRecovered(result); setHydrated(true); } })
      .catch(e => { if (active) setError("恢复失败：" + e.message); })
      .finally(() => { if (active) setBusy(""); });
    return () => { active = false; };
  }, []);

  function relink(horizon_id: string | null) {
    task("重新定位数据文件…", async () => {
      const result = await (await api("/workspace/relink", json({ project_id: project?.project_id, horizon_id }))).json();
      if (!result.cancelled) { applyRecovered(result); setHydrated(true); }
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Load colormaps                                                           */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    api("/catalog")
      .then((r) => r.json())
      .then((c) => { setMaps(c.colormaps); setMapColors(c.map_colormaps || c.colormaps); })
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
    setBusy(label);
    setError("");

    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Export queue                                                             */
  /* ------------------------------------------------------------------------ */

  const {
    items: queue,
    sessionId: queueSession,
    addItem: queueItem,
    rename: renameQueueItem,
    remove: deleteQueueItem,
    clear: clearQueue,
    exportItems,
  } = useExportQueue({ task, notify: setNotice, onError: setError });

  /* ------------------------------------------------------------------------ */
  /* Dataset loaded                                                           */
  /* ------------------------------------------------------------------------ */

  function loaded(result: WorkspaceResponse) {
    if (!result.metadata) return;
    requestId.current++;

    setSection(null);
    setMeta(result.metadata);
    setDataset("");
    setSelected(result.horizons[0]?.id || "");
    setProject({ ...result, issues: [] });
    setHydrated(true);
    setView(loadedView(result.metadata, result.horizons));
    const map = initialMapWorkspace();
    map.state.horizon = result.horizons[0]?.id || "";
    setMapWorkspace(map);

    setNotice("数据已加载");
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
      const job_id = crypto.randomUUID();
      setImportProgress({
        percent: 0,
        stage: "请在系统窗口选择文件",
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
      const preview = await (
        await api("/horizons/pick", { method: "POST" })
      ).json();
      if (preview.cancelled) return;

      setHorizonImport({
        token: preview.token,
        filename: preview.filename,
        filenames: preview.filenames,
        columns: preview.columns,
        rows: preview.rows,
        inline_column: preview.suggestions.inline,
        xline_column: preview.suggestions.xline,
        time_column: preview.suggestions.time,
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
          }),
        )
      ).json();

      setView((v) => ({
        ...v,
        horizons: [...v.horizons, ...hs],
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
  /* Request 2D section                                                       */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    if (!meta || view.view_mode !== "2d") {
      setLoading(false);
      return;
    }

    const id = ++requestId.current;
    const abort = new AbortController();

    setLoading(true);

    // Adaptive resolution: ask for the pixels the plot area really shows, so a
    // zoom can pull finer data out of the SEG-Y instead of magnifying a raster.
    const box = plotWrap.current;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);

    // Two-stage refresh: the current raster stays visible until the debounce
    // expires and the viewport-matched window arrives.
    const timer = setTimeout(async () => {
      try {
        const r = await api("/section", {
          ...json({
            ...viewRef.current,
            quality: "interactive",
            target_width: box ? Math.round(box.clientWidth * ratio) : null,
            target_height: box ? Math.round(box.clientHeight * ratio) : null,
          }),
          signal: abort.signal,
        });

        const s = await r.json();

        if (id === requestId.current) {
          setSection(s);
          setError("");
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError" && id === requestId.current) {
          setError((e as Error).message);
        }
      } finally {
        if (id === requestId.current) {
          setLoading(false);
        }
      }
    }, 200);

    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [
    meta,
    view.view_mode,
    view.view_type,
    view.section_number,
    view.seismic.clip_mode,
    view.seismic.clip_percentile,
    view.seismic.symmetric,
    view.seismic.vmin,
    view.seismic.vmax,
    view.seismic.reverse_polarity,
    view.seismic.interpolation,
    view.seismic.adaptive_resolution,
    view.x_range,
    view.time_range,
    revision,
  ]);

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

  function style(p: Partial<HS>) {
    setView((v) => ({
      ...v,
      horizons: v.horizons.map((h) =>
        h.id === selected
          ? {
              ...h,
              ...p,
            }
          : h,
      ),
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
  /* Add to export (renders happen in the viewer components / backend)        */
  /* ------------------------------------------------------------------------ */

  function add2DToQueue() {
    setExportOpen(false);
    task("正在保存二维图件…", async () => {
      await queueItem({ kind: "2d", dataset, state: view, settings });
    });
  }

  async function add3DToQueue(settings3D: any) {
    setExportOpen(false);
    await task("正在保存三维图件…", async () => {
      const exportStarted = performance.now();
      if (!sceneRef.current) throw new Error("三维场景未就绪");
      const capture = await sceneRef.current.captureFigure(settings3D, setBusy);
      setBusy(`封装 ${capture.format.toUpperCase()} 并加入队列…`);
      await queueItem({
        kind: "3d",
        dataset,
        png: capture.png,
        format: capture.format,
        width_px: capture.width_px,
        height_px: capture.height_px,
        scale: capture.scale,
        render_dpi: capture.render_dpi,
        timings: capture.timings,
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

  async function addMapToQueue(payload: { state: unknown; settings: unknown }) {
    await task("正在保存层位地图…", async () => {
      await queueItem({
        kind: "map",
        dataset,
        state: payload.state,
        settings: payload.settings,
      });
    });
  }

  async function addProfileToQueue(
    payload: Record<string, unknown> & { settings: unknown },
  ) {
    await task("正在保存 A–B 剖面…", async () => {
      await queueItem({ kind: "profile", dataset, ...payload });
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Render                                                                   */
  /* ------------------------------------------------------------------------ */

  return (
    <div className="app">
      {/* ------------------------------------------------------------------ */}
      {/* Top bar                                                            */}
      {/* ------------------------------------------------------------------ */}

      <header className="topbar">
        <div className="brand">
          <img
            className="brand-mark"
            src={
              new URL("./assets/seiscanvas-symbol.svg", import.meta.url).href
            }
            alt=""
            width={44}
            height={44}
          />

          <img
            className="brand-wordmark"
            src={
              new URL("./assets/seiscanvas-wordmark.svg", import.meta.url).href
            }
            alt="SeisCanvas"
            width={140}
            height={24}
          />

          <span className="version">V0.2</span>
        </div>

        <div className="top-status">
          <span className="status-dot" />
          本地
          <span className="autosave-status" role="status">
            {busy === "正在恢复上次工作…" ? "恢复中…" : project?.issues.length ? "恢复待处理" : saveStatus === "saving" ? "保存中…" : saveStatus === "saved" ? "已保存" : saveStatus === "error" ? "保存失败" : ""}
          </span>
        </div>

        <button
          className="primary"
          disabled={
            !meta ||
            !!busy ||
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
        </button>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Workspace                                                          */}
      {/* ------------------------------------------------------------------ */}

      <div className="workspace">
        {/* ---------------------------------------------------------------- */}
        {/* Sidebar                                                          */}
        {/* ---------------------------------------------------------------- */}

          <aside className="sidebar" hidden={!sidebar}>
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

            {meta && view.view_mode === "3d" && (
              <SceneControls
                scene={view.scene}
                onChange={(scene) => setView((v) => ({ ...v, scene }))}
              />
            )}
          </aside>

        {/* ---------------------------------------------------------------- */}
        {/* Main                                                             */}
        {/* ---------------------------------------------------------------- */}

        <main>
          {project?.issues.map((issue, index) => (
            <div className="error recovery-issue" role="alert" key={index}>
              <span>{issue.message}。原来的工作记录已保留。</span>
              <button className="secondary" disabled={!!busy} onClick={() => relink(issue.horizon_id)}>重新定位</button>
            </div>
          ))}
          <div className="breadcrumb">
            <button
              className="icon"
              title="收起或展开控制面板"
              aria-expanded={sidebar}
              onClick={() => setSidebar((s) => !s)}
            >
              {sidebar ? (
                <PanelLeftClose size={17} />
              ) : (
                <PanelLeftOpen size={17} />
              )}
            </button>
            <div className="view-mode-switch segmented" role="group" aria-label="视图模式">
              {(["2d", "3d", "map"] as const).map(mode => (
                <button
                  key={mode}
                  disabled={!!busy || (mode !== "2d" && !meta) || (mode === "map" && !view.horizons.length)}
                  className={view.view_mode === mode ? "active" : ""}
                  aria-pressed={view.view_mode === mode}
                  onClick={() => { setExportOpen(false); setView(v => ({ ...v, view_mode: mode })); }}
                >
                  {mode === "map" ? "层位地图" : mode.toUpperCase()}
                </button>
              ))}
            </div>
            {meta && <span className="workspace-name" title={meta.filename}>{dataset || datasetPlaceholder}</span>}
          </div>

          {error && (
            <div role="alert" className="error">
              <span>{error}</span>

              <button className="icon" onClick={() => setError("")}>
                <X size={14} />
              </button>
            </div>
          )}

          {view.view_mode === "map" ? (
            <HorizonMap
              controlsHost={mapControlsHost}
              workspace={mapWorkspace}
              onWorkspace={setMapWorkspace}
              horizons={view.horizons}
              maps={maps}
              mapColors={mapColors}
              seismic={view.seismic}
              aspect={view.aspect_ratio_2d}
              onSeismic={seismic}
              onAspect={(ratio) =>
                setView((v) => ({ ...v, aspect_ratio_2d: ratio }))
              }
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
                      view={view}
                      section={section}
                      colors={colors}
                      drag={drag}
                      onPatch={setView}
                      onProbe={runProbe}
                      onError={setError}
                    />
                  ) : (
                    <div className="empty">
                      <div className="empty-icon">
                        <Activity size={32} strokeWidth={1.5} />
                      </div>

                      <h2>暂无地震数据</h2>

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
                  )}

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
                    TWT {meta.time_range[0]}–{meta.time_range[1]} ms
                  </span>
                ) : (
                  <span>未加载数据</span>
                )}
              </div>
            </>
          )}
        </main>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Toast                                                              */}
      {/* ------------------------------------------------------------------ */}

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
          busy={!!busy}
          disabled={loading}
          error={error}
        />
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Export queue                                                       */}
      {/* ------------------------------------------------------------------ */}

      <ExportQueue
        open={queueOpen}
        items={queue}
        session={queueSession}
        busy={!!busy}
        onClose={() => setQueueOpen(false)}
        onRename={renameQueueItem}
        onDelete={deleteQueueItem}
        onClear={clearQueue}
        onExport={exportItems}
      />

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
        />
      )}

      {horizonToDelete && (
        <div className="modal-backdrop" onClick={() => !busy && setHorizonToDelete(null)}>
          <div ref={deleteDialog} tabIndex={-1} className="modal delete-horizon-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-horizon-title" onClick={e => e.stopPropagation()}>
            <h2 id="delete-horizon-title">移除层位 {horizonToDelete.name}？</h2>
            <p>将从当前工作区移除该层位及其样式，原始数据文件会保留。</p>
            {mapWorkspace.state.color_by === "difference" && (mapWorkspace.state.difference_reference === horizonToDelete.id || mapWorkspace.state.difference_comparison === horizonToDelete.id) && (
              <p className="delete-horizon-impact">此层位用于差值计算，移除后需要重新选择参考或对比层位。</p>
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
  );
}
