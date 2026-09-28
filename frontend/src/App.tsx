import ExportDialog from "./components/ExportDialog";
import ExportQueue from "./components/ExportQueue";
import HorizonMap from "./components/HorizonMap";
import { useState, useEffect, useRef, useMemo } from "react";
import Plotly from "plotly.js-dist-min";
import {
  Activity,
  Upload,
  Plus,
  Trash2,
  ChevronRight,
  RotateCcw,
  Layers,
  SlidersHorizontal,
  FolderOpen,
  MousePointer2,
  Move,
  Check,
  X,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Package,
} from "lucide-react";

import { HS, SS, VS, Meta, Section, ExportItem, defaultScene, makeSlice } from "./types";
import { Toggle, Num, Group } from "./components/Controls";
import Scene3D, {
  Scene3DHandle,
} from "./components/SeismicViewer3D/Scene3D";
import {
  SliceManager,
  SceneControls,
  Horizon3DControls,
  Export3DDialog,
} from "./components/SeismicViewer3D/Controls3D";

type HorizonImportState = {
  token: string;
  filename: string;
  columns: { index: number; name: string }[];
  rows: string[][];
  inline_column: number;
  xline_column: number;
  time_column: number;
};

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
  },

  horizons: [],
};

const initialExport = {
  width: 180,
  height: 100,
  dpi: 300,

  font: "Times New Roman",
  font_size: 10,

  show_axes: true,
  show_labels: true,
  show_title: true,

  format: "png",
};

/* -------------------------------------------------------------------------- */
/* API                                                                        */
/* -------------------------------------------------------------------------- */

async function api(path: string, init?: RequestInit) {
  const r = await fetch("/api" + path, init);

  if (!r.ok) {
    const b = await r.json().catch(() => ({
      detail: r.statusText,
    }));

    throw new Error(
      typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail),
    );
  }

  return r;
}

const json = (value: unknown) => ({
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify(value),
});

/* -------------------------------------------------------------------------- */
/* App                                                                        */
/* -------------------------------------------------------------------------- */

export default function App() {
  /* ------------------------------------------------------------------------ */
  /* Refs                                                                     */
  /* ------------------------------------------------------------------------ */

  const sceneRef = useRef<Scene3DHandle>(null);
  const plot = useRef<HTMLDivElement>(null);


  const requestId = useRef(0);

  /* ------------------------------------------------------------------------ */
  /* State                                                                    */
  /* ------------------------------------------------------------------------ */

  const [sceneReady, setSceneReady] = useState(false);
  const [importProgress, setImportProgress] = useState<{percent:number;stage:string;status:string}|null>(null);
  const [mapReady, setMapReady] = useState(false);

  const [meta, setMeta] = useState<Meta | null>(null);
  const [view, setView] = useState<VS>(initial);
  const [section, setSection] = useState<Section | null>(null);

  const viewRef = useRef(view);

  const [maps, setMaps] = useState<Record<string, any[]>>({});

  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(false);

  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [geometryMode, setGeometryMode] = useState("auto");
  const [bytes, setBytes] = useState({
    il: 189,
    xl: 21,
  });

  const [selected, setSelected] = useState("");

  const [horizonImport, setHorizonImport] =
    useState<HorizonImportState | null>(null);

  const [exportOpen, setExportOpen] = useState(false);
  const [settings, setSettings] = useState(initialExport);

  const [queue, setQueue] = useState<ExportItem[]>([]);
  const [queueSession, setQueueSession] = useState("");
  const [queueOpen, setQueueOpen] = useState(false);
  const [dataset, setDataset] = useState("");

  const [drag, setDrag] = useState<"zoom" | "pan">("zoom");

  const [sidebar, setSidebar] = useState(true);

  const [revision, setRevision] = useState(0);

  viewRef.current = view;

  /* ------------------------------------------------------------------------ */
  /* Load colormaps                                                           */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    api("/catalog")
      .then((r) => r.json())
      .then((c) => setMaps(c.colormaps))
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
  /* Dataset loaded                                                           */
  /* ------------------------------------------------------------------------ */

  function loaded(result: {
    metadata: Meta;
    horizons: HS[];
  }) {
    requestId.current++;

    setSection(null);
    setMeta(result.metadata);
    setDataset("");
    setSelected(result.horizons[0]?.id || "");

    const centerInline =
      result.metadata.inlines[
        Math.floor(result.metadata.inlines.length / 2)
      ];

    const centerCrossline =
      result.metadata.crosslines[
        Math.floor(result.metadata.crosslines.length / 2)
      ];

    const centerTime =
      result.metadata.time_range[0] +
      Math.round((result.metadata.samples - 1) / 2) *
        result.metadata.sample_interval;

    setView({
      ...initial,

      slices: {
        inline: [makeSlice(centerInline)],
        crossline: [makeSlice(centerCrossline)],
        time: [makeSlice(centerTime)],
      },

      scene: structuredClone(defaultScene),

      section_number: centerInline,

      horizons: result.horizons,
    });

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
      const r = await api(
        `/example?ilbyte=${bytes.il}&xlbyte=${bytes.xl}`,
        {
          method: "POST",
        },
      );

      loaded(await r.json());
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Upload SEG-Y                                                             */
  /* ------------------------------------------------------------------------ */

  function openSegy() {
    task("正在导入 SEG-Y…", async () => {
      const job_id = crypto.randomUUID();
      setImportProgress({percent:0, stage:"请在系统窗口选择文件", status:"waiting"});
      let active = true;
      let timer: ReturnType<typeof setTimeout>;
      const poll = async () => {
        try {
          const r = await api(`/segy/progress/${job_id}`);
          const p = await r.json();
          if (active) setImportProgress(p);
        } catch { /* The import request reports failures. */ }
        if (active) timer = setTimeout(poll, 600);
      };
      timer = setTimeout(poll, 300);
      try {
        const r = await api("/segy/pick", json({job_id, ilbyte: bytes.il, xlbyte: bytes.xl, geometry_mode: geometryMode}));
        const result = await r.json();
        active = false;
        if (!result.cancelled) {
          loaded(result);
          setImportProgress({percent:100, stage:"导入完成", status:"done"});
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
      const preview = await (await api("/horizons/pick", {method: "POST"})).json();
      if (preview.cancelled) return;

      setHorizonImport({
        token: preview.token,
        filename: preview.filename,
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
      const hs = await (await api("/horizons/local", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({token: horizonImport.token,
          inline_column: horizonImport.inline_column,
          xline_column: horizonImport.xline_column, time_column: horizonImport.time_column}),
      })).json();

      setView((v) => ({
        ...v,
        horizons: [...v.horizons, ...hs],
      }));

      setSelected(hs[0].id);

      setRevision((v) => v + 1);
      setHorizonImport(null);
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

    const timer = setTimeout(async () => {
      try {
        const r = await api("/section", {
          ...json(viewRef.current),
          signal: abort.signal,
        });

        const s = await r.json();

        if (id === requestId.current) {
          setSection(s);
          setError("");
        }
      } catch (e) {
        if (
          (e as Error).name !== "AbortError" &&
          id === requestId.current
        ) {
          setError((e as Error).message);
        }
      } finally {
        if (id === requestId.current) {
          setLoading(false);
        }
      }
    }, 120);

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
    revision,
  ]);

  /* ------------------------------------------------------------------------ */
  /* Sections                                                                 */
  /* ------------------------------------------------------------------------ */

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

  const active = view.horizons.find((h) => h.id === selected);

  /* ------------------------------------------------------------------------ */
  /* Colormap preview                                                         */
  /* ------------------------------------------------------------------------ */

  const colors = maps[view.seismic.colormap] || [];

  const preview = useMemo(() => {
    const values = (
      view.seismic.reverse_colormap
        ? [...colors].reverse()
        : colors
    )
      .filter((_, i) => i % 16 === 0)
      .map((c) => c[1])
      .join(",");

    return `linear-gradient(90deg,${values})`;
  }, [colors, view.seismic.reverse_colormap]);

  /* ------------------------------------------------------------------------ */
  /* Plotly                                                                   */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    if (!plot.current || !section || view.view_mode !== "2d") return;

    const s = view.seismic;

    const colorScale = s.reverse_colormap
      ? colors.map((c, i) => [
          c[0],
          colors[colors.length - 1 - i][1],
        ])
      : colors;

    const z = s.reverse_polarity
      ? section.z.map((r) => r.map((v) => -v))
      : section.z;

    const inline = view.view_type === "inline";

    const traces: any[] = [
      {
        type: "heatmap",

        x: section.x,
        y: section.time,
        z,

        colorscale: colorScale.length
          ? colorScale
          : "RdBu",

        zmin: section.vmin,
        zmax: section.vmax,

        showscale: false,
        zsmooth: false,

        hovertemplate:
          `Inline: ${inline ? view.section_number : "%{x}"}` +
          `<br>Crossline: ${inline ? "%{x}" : view.section_number}` +
          `<br>TWT: %{y:.1f} ms` +
          `<br>Amplitude: %{z:.3f}` +
          `<extra></extra>`,
      },
    ];

    const dash: Record<string, string> = {
      solid: "solid",
      dashed: "dash",
      dotted: "dot",
      dashdot: "dashdot",
    };

    const symbols: Record<string, string> = {
      circle: "circle",
      square: "square",
      triangle: "triangle-up",
      diamond: "diamond",
      cross: "x",
      plus: "cross",
    };

    for (const h of view.horizons) {
      const pts = section.horizons[h.id] || [];

      if (!h.visible || !pts.length) continue;

      const line =
        h.line.visible &&
        h.line.style !== "none";

      const marker =
        h.marker.visible &&
        h.marker.shape !== "none";

      if (!line && !marker) continue;

      const base = {
        type: "scatter",

        x: pts.map((p) => p[0]),
        y: pts.map((p) => p[1]),

        showlegend: false,
        connectgaps: false,
      };

      if (line && h.outline.enabled) {
        traces.push({
          ...base,

          mode: "lines",

          line: {
            color: "#000",

            width:
              ((h.line.width +
                2 * h.outline.width) *
                4) /
              3,

            dash: dash[h.line.style],
          },

          hoverinfo: "skip",
        });
      }

      traces.push({
        ...base,

        name: h.name,

        mode:
          line && marker
            ? "lines+markers"
            : line
              ? "lines"
              : "markers",

        line: {
          color: h.color,
          width: (h.line.width * 4) / 3,
          dash: dash[h.line.style],
        },

        marker: {
          color: h.color,

          size:
            (h.marker.size * 4) / 3,

          symbol:
            symbols[h.marker.shape],

          line: {
            color: "#000",

            width: h.outline.enabled
              ? (h.outline.width * 4) / 3
              : 0,
          },
        },

        hovertemplate:
          `${h.name.replaceAll("<", "&lt;")}` +
          `<br>${inline ? "Crossline" : "Inline"}: %{x}` +
          `<br>TWT: %{y:.1f} ms` +
          `<extra></extra>`,
      });
    }

    const xr =
      view.x_range ||
      [
        section.x[0] - 0.5,
        section.x.at(-1)! + 0.5,
      ];

    const tr =
      view.time_range ||
      [
        section.time[0],
        section.time.at(-1)!,
      ];

    const layout: any = {
      autosize: true,

      margin: {
        l: 72,
        r: 28,
        t: 28,
        b: 60,
      },

      paper_bgcolor: "#fff",
      plot_bgcolor: "#fff",

      font: {
        family: "Inter, Arial, sans-serif",
        color: "#425367",
        size: 11,
      },

      dragmode: drag,

      xaxis: {
        title: {
          text: inline
            ? "Crossline"
            : "Inline",
          standoff: 18,
        },

        constrain: "domain",
        range: [...xr],
        autorange: false,

        showgrid: false,
        zeroline: false,

        linecolor: "#bcc8cf",
        ticks: "outside",
      },

      yaxis: {
        constrain: "domain",
        scaleanchor: view.aspect_ratio_2d ? "x" : false,
        scaleratio: view.aspect_ratio_2d
          ? (view.aspect_ratio_2d[1] / view.aspect_ratio_2d[0]) *
            Math.abs((xr[1] - xr[0]) / (tr[1] - tr[0]))
          : 1,
        title: {
          text: "TWT (ms)",
          standoff: 16,
        },

        range: [
          Math.max(...tr),
          Math.min(...tr),
        ],

        autorange: false,

        showgrid: false,
        zeroline: false,

        linecolor: "#bcc8cf",
        ticks: "outside",
      },

      hovermode: "closest",
    };

    const el = plot.current as any;

    let disposed = false;

    Plotly.react(
      el,
      traces,
      layout,
      {
        responsive: true,
        displayModeBar: false,
        scrollZoom: true,
      },
    )
      .then(() => {
        if (disposed) return;

        el.removeAllListeners?.(
          "plotly_relayout",
        );

        el.on(
          "plotly_relayout",
          (e: any) => {
            if (
              e["xaxis.autorange"] ||
              e["yaxis.autorange"]
            ) {
              setView((v) => ({
                ...v,
                x_range: null,
                time_range: null,
              }));

              return;
            }

            if (
              e["xaxis.range[0]"] !==
                undefined ||
              e["yaxis.range[0]"] !==
                undefined
            ) {
              setView((v) => ({
                ...v,

                x_range:
                  e["xaxis.range[0]"] !==
                  undefined
                    ? [
                        e[
                          "xaxis.range[0]"
                        ],
                        e[
                          "xaxis.range[1]"
                        ],
                      ]
                    : v.x_range,

                time_range:
                  e["yaxis.range[0]"] !==
                  undefined
                    ? [
                        Math.min(
                          e[
                            "yaxis.range[0]"
                          ],
                          e[
                            "yaxis.range[1]"
                          ],
                        ),

                        Math.max(
                          e[
                            "yaxis.range[0]"
                          ],
                          e[
                            "yaxis.range[1]"
                          ],
                        ),
                      ]
                    : v.time_range,
              }));
            }
          },
        );
      })
      .catch((e) => {
        setError(String(e));
      });

    return () => {
      disposed = true;
    };
  }, [
    section,
    view,
    colors,
    drag,
  ]);

  /* ------------------------------------------------------------------------ */
  /* Resize Plotly                                                            */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    const el = plot.current;

    if (!el) return;

    const ob = new ResizeObserver(() => {
      if ((el as any).data) {
        Plotly.Plots.resize(el);
      }
    });

    ob.observe(el);

    return () => ob.disconnect();
  }, [
    section,
    sidebar,
    view.view_mode,
  ]);

  /* ------------------------------------------------------------------------ */
  /* Purge Plotly                                                             */
  /* ------------------------------------------------------------------------ */

  useEffect(
    () => () => {
      if (plot.current) {
        Plotly.purge(plot.current);
      }
    },
    [],
  );

  /* ------------------------------------------------------------------------ */
  /* Export queue                                                             */
  /* ------------------------------------------------------------------------ */

  async function refreshQueue() {
    try {
      const r = await api("/export/queue");
      const data = await r.json();
      setQueue(data.items || []);
      setQueueSession(data.session || "");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    refreshQueue();
  }, []);

  async function queueItem(body: Record<string, unknown>) {
    const r = await api("/export/queue", json(body));
    const item: ExportItem = await r.json();
    await refreshQueue();
    setNotice(`Added to Export Queue\n${item.filename}`);
    return item;
  }

  /* Render the current view at the publication settings and stash the result. */

  function add2DToQueue() {
    setExportOpen(false);
    task("正在渲染并加入导出队列…", async () => {
      await queueItem({ kind: "2d", dataset, state: view, settings });
    });
  }

  async function add3DToQueue(settings3D: any) {
    setExportOpen(false);
    await task("正在渲染三维图片并加入导出队列…", async () => {
      if (!sceneRef.current) throw new Error("三维场景未就绪");
      const capture = await sceneRef.current.captureFigure(settings3D);
      await queueItem({
        kind: "3d",
        dataset,
        png: capture.png,
        format: capture.format,
        width_px: capture.width_px,
        height_px: capture.height_px,
        scale: capture.scale,
        settings: settings3D,
        state: view,
      });
    });
  }

  async function addMapToQueue(payload: { state: unknown; settings: unknown }) {
    await task("正在绘制层位地图并加入导出队列…", async () => {
      await queueItem({ kind: "map", dataset, state: payload.state, settings: payload.settings });
    });
  }

  function renameQueueItem(item: ExportItem, filename: string) {
    return task("重命名导出文件…", async () => {
      await api(`/export/queue/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      await refreshQueue();
    });
  }

  function deleteQueueItem(item: ExportItem) {
    task("删除暂存图片…", async () => {
      await api(`/export/queue/${item.id}`, { method: "DELETE" });
      await refreshQueue();
    });
  }

  function clearQueue() {
    task("清空导出队列…", async () => {
      await api("/export/queue", { method: "DELETE" });
      await refreshQueue();
      setNotice("Export queue cleared");
    });
  }

  function exportAll() {
    task("正在打包 ZIP…", async () => {
      const r = await api("/export/archive", { method: "POST" });
      const header = r.headers.get("X-Export-Filename");
      let name = "SeisCanvas_Export.zip";
      if (header) {
        try {
          name = decodeURIComponent(header);
        } catch {
          name = header;
        }
      }
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`ZIP 已导出\n${name}`);
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
          <div className="brand-mark">
            <Activity size={23} />
          </div>

          <span>SeisCanvas</span>

          <span className="version">
            V0.1
          </span>
        </div>

        <div className="top-status">
          <span className="status-dot" />
          本地
        </div>

        <button
          className="primary"
          disabled={
            !meta ||
            !!busy ||
            (view.view_mode === "2d"
              ? loading
              : view.view_mode === "map" ? !mapReady : !sceneReady)
          }
          onClick={() =>
            setExportOpen(true)
          }
        >
          <Plus size={15} />
          Add to Export
        </button>

        <button
          className="secondary queue-button"
          onClick={() => setQueueOpen(true)}
          title="导出队列"
        >
          <Package size={15} />
          Export Queue · {queue.length}
        </button>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Workspace                                                          */}
      {/* ------------------------------------------------------------------ */}

      <div className="workspace">
        {/* ---------------------------------------------------------------- */}
        {/* Sidebar                                                          */}
        {/* ---------------------------------------------------------------- */}

        {sidebar && (
          <aside className="sidebar">
            {/* ------------------------------------------------------------ */}
            {/* Data                                                         */}
            {/* ------------------------------------------------------------ */}

            <Group
              icon={
                <FolderOpen size={16} />
              }
              title="数据"
            >
              {importProgress && <div className="import-progress" role="status" aria-live="polite">
                <div><span>{importProgress.stage}</span><b>{importProgress.status === "waiting" ? "" : `${importProgress.percent}%`}</b></div>
                <progress aria-label="SEG-Y 导入进度" max={100}
                  value={importProgress.status === "waiting" ? undefined : importProgress.percent} />
              </div>}
              <button
                className="primary full"
                disabled={!!busy}
                onClick={() =>
                  openSegy()
                }
              >
                <Upload size={14} />
                导入 SEG-Y
              </button>



              <button
                className="secondary full"
                disabled={!!busy}
                onClick={loadExample}
              >
                <Layers size={14} />
                加载 F3 示例
              </button>

              <label className="field">Geometry Mode
                <select value={geometryMode} disabled={!!busy} onChange={e => setGeometryMode(e.target.value)}>
                  <option value="auto">Auto</option>
                  <option value="regular">Regular Grid (Fast)</option>
                </select>
              </label>
              <div className="field-row">
                <label>
                  Inline byte

                  <Num
                    value={bytes.il}
                    onChange={(il) =>
                      setBytes((b) => ({
                        ...b,
                        il,
                      }))
                    }
                    min={1}
                    max={237}
                  />
                </label>

                <label>
                  Crossline byte

                  <Num
                    value={bytes.xl}
                    onChange={(xl) =>
                      setBytes((b) => ({
                        ...b,
                        xl,
                      }))
                    }
                    min={1}
                    max={237}
                  />
                </label>
              </div>

              {meta && (
                <div className="metadata">
                  <div
                    className="filename"
                    title={meta.filename}
                  >
                    <span className="status-dot" />
                    {meta.filename}
                  </div>

                  <div>
                    <span>Inline</span>

                    <b>
                      {meta.inlines[0]}–
                      {meta.inlines.at(-1)}

                      <em>
                        {" "}
                        ({meta.inlines.length})
                      </em>
                    </b>
                  </div>

                  <div>
                    <span>
                      Crossline
                    </span>

                    <b>
                      {meta.crosslines[0]}–
                      {meta.crosslines.at(-1)}

                      <em>
                        {" "}
                        (
                        {
                          meta.crosslines
                            .length
                        }
                        )
                      </em>
                    </b>
                  </div>

                  <div>
                    <span>TWT</span>

                    <b>
                      {meta.time_range.join(
                        "–",
                      )}{" "}
                      ms
                    </b>
                  </div>

                  <div>
                    <span>采样</span>

                    <b>
                      {meta.samples} ×{" "}
                      {
                        meta.sample_interval
                      }{" "}
                      ms
                    </b>
                  </div>
                </div>
              )}
            </Group>

            {/* ------------------------------------------------------------ */}
            {/* 2D / 3D                                                      */}
            {/* ------------------------------------------------------------ */}

            <div
              className="view-mode-switch segmented"
              aria-label="视图模式"
            >
              <button
                className={
                  view.view_mode === "2d"
                    ? "active"
                    : ""
                }
                onClick={() =>
                  setView((v) => ({
                    ...v,
                    view_mode: "2d",
                  }))
                }
              >
                2D
              </button>

              <button
                disabled={!meta}
                className={
                  view.view_mode === "3d"
                    ? "active"
                    : ""
                }
                onClick={() =>
                  setView((v) => ({
                    ...v,
                    view_mode: "3d",
                  }))
                }
              >
                3D
              </button>
              <button disabled={!view.horizons.length}
                className={view.view_mode === "map" ? "active" : ""}
                onClick={() => setView(v => ({...v, view_mode: "map"}))}>
                Horizon Map
              </button>
            </div>

            {/* ------------------------------------------------------------ */}
            {/* 3D controls                                                  */}
            {/* ------------------------------------------------------------ */}

            {view.view_mode === "map" && <div id="horizon-map-controls" />}
            {view.view_mode === "3d" &&
              meta && (
                <>
                  <SliceManager
                    key={
                      meta.filename +
                      revision
                    }
                    meta={meta}
                    slices={view.slices}
                    disabled={!!busy}
                    onChange={(slices) =>
                      setView((v) => ({
                        ...v,
                        slices,
                      }))
                    }
                  />

                  <SceneControls
                    scene={view.scene}
                    onChange={(scene) =>
                      setView((v) => ({
                        ...v,
                        scene,
                      }))
                    }
                  />
                </>
              )}

            {/* ------------------------------------------------------------ */}
            {/* Section                                                      */}
            {/* ------------------------------------------------------------ */}

            {view.view_mode === "2d" && (
              <Group
                icon={
                  <SlidersHorizontal
                    size={16}
                  />
                }
                title="剖面"
              >
                <div className="segmented">
                  {(
                    [
                      "inline",
                      "crossline",
                    ] as const
                  ).map((m) => (
                    <button
                      key={m}
                      className={
                        view.view_type === m
                          ? "active"
                          : ""
                      }
                      disabled={
                        !meta || !!busy
                      }
                      onClick={() =>
                        changeMode(m)
                      }
                    >
                      {m === "inline"
                        ? "Inline"
                        : "Crossline"}
                    </button>
                  ))}
                </div>

                <Toggle
                  label="固定横纵比例"
                  checked={!!view.aspect_ratio_2d}
                  onChange={(enabled) => setView((v) => ({
                    ...v, aspect_ratio_2d: enabled ? [2, 1] : null,
                  }))}
                />
                {view.aspect_ratio_2d && (
                  <div className="field-row">
                    {["横向比例", "纵向比例"].map((label, index) => (
                      <label key={label}>{label}
                        <Num value={view.aspect_ratio_2d![index]}
                          min={0.1} max={5} step={0.1}
                          onChange={(n) => setView((v) => {
                            const ratio: [number, number] = [...(v.aspect_ratio_2d || [2, 1])];
                            ratio[index] = n;
                            return { ...v, aspect_ratio_2d: ratio };
                          })}
                        />
                      </label>
                    ))}
                  </div>
                )}

                <div className="section-number">
                  <span>
                    剖面编号
                  </span>

                  <Num
                    value={
                      view.section_number
                    }
                    onChange={
                      changeSection
                    }
                    min={sections[0]}
                    max={sections.at(-1)}
                  />
                </div>

                <input
                  aria-label="剖面滑块"
                  type="range"
                  disabled={
                    !meta || !!busy
                  }
                  min={0}
                  max={Math.max(
                    0,
                    sections.length - 1,
                  )}
                  value={Math.max(
                    0,
                    sections.indexOf(
                      view.section_number,
                    ),
                  )}
                  onChange={(e) =>
                    changeSection(
                      sections[
                        +e.target.value
                      ],
                    )
                  }
                />

                <div className="range-labels">
                  <span>
                    {sections[0] ?? "—"}
                  </span>

                  <span>
                    {sections.at(-1) ??
                      "—"}
                  </span>
                </div>
              </Group>
            )}

            {/* ------------------------------------------------------------ */}
            {/* Seismic display                                              */}
            {/* ------------------------------------------------------------ */}

            <div hidden={view.view_mode === "map"}>
            <Group
              icon={
                <Activity size={16} />
              }
              title="地震显示"
            >
              <label className="field">
                色标

                <select
                  value={
                    view.seismic.colormap
                  }
                  onChange={(e) =>
                    seismic({
                      colormap:
                        e.target.value,
                    })
                  }
                >
                  {Object.keys(
                    maps,
                  ).map((n) => (
                    <option key={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>

              <div
                className="color-preview"
                style={{
                  background: preview,
                }}
              />

              <div className="check-row">
                <Toggle
                  label="反转色标"
                  checked={
                    view.seismic
                      .reverse_colormap
                  }
                  onChange={(
                    reverse_colormap,
                  ) =>
                    seismic({
                      reverse_colormap,
                    })
                  }
                />

                <Toggle
                  label="反转极性"
                  checked={
                    view.seismic
                      .reverse_polarity
                  }
                  onChange={(
                    reverse_polarity,
                  ) =>
                    seismic({
                      reverse_polarity,
                    })
                  }
                />
              </div>

              <label className="field">
                振幅范围

                <select
                  value={
                    view.seismic
                      .clip_mode
                  }
                  onChange={(e) =>
                    seismic({
                      clip_mode:
                        e.target.value,
                    })
                  }
                >
                  <option value="percentile">
                    百分位
                  </option>

                  <option value="manual">
                    手动
                  </option>
                </select>
              </label>

              {view.seismic.clip_mode ===
              "percentile" ? (
                <>
                  <div className="section-number">
                    <span>
                      裁剪百分位 %
                    </span>

                    <Num
                      value={
                        view.seismic
                          .clip_percentile
                      }
                      min={0.1}
                      max={100}
                      step={0.1}
                      onChange={(
                        clip_percentile,
                      ) =>
                        seismic({
                          clip_percentile,
                        })
                      }
                    />
                  </div>

                  <Toggle
                    label="零中心对称"
                    checked={
                      view.seismic
                        .symmetric
                    }
                    onChange={(
                      symmetric,
                    ) =>
                      seismic({
                        symmetric,
                      })
                    }
                  />
                </>
              ) : (
                <div className="field-row">
                  <label>
                    Min

                    <Num
                      value={
                        view.seismic
                          .vmin ?? 0
                      }
                      onChange={(vmin) =>
                        seismic({
                          vmin,
                        })
                      }
                    />
                  </label>

                  <label>
                    Max

                    <Num
                      value={
                        view.seismic
                          .vmax ?? 1
                      }
                      onChange={(vmax) =>
                        seismic({
                          vmax,
                        })
                      }
                    />
                  </label>
                </div>
              )}
            </Group>

            {/* ------------------------------------------------------------ */}
            {/* Horizons                                                     */}
            {/* ------------------------------------------------------------ */}

            <Group
              icon={
                <Layers size={16} />
              }
              title={`层位 · ${view.horizons.length}`}
            >
              <div className="horizon-list">
                {view.horizons.map(
                  (h) => (
                    <div
                      key={h.id}
                      className={
                        `horizon-row ` +
                        `${
                          selected === h.id
                            ? "selected"
                            : ""
                        }`
                      }
                    >
                      <input
                        aria-label={`显示 ${h.name}`}
                        type="checkbox"
                        checked={
                          h.visible
                        }
                        onChange={(e) =>
                          setView(
                            (v) => ({
                              ...v,

                              horizons:
                                v.horizons.map(
                                  (a) =>
                                    a.id ===
                                    h.id
                                      ? {
                                          ...a,
                                          visible:
                                            e
                                              .target
                                              .checked,
                                        }
                                      : a,
                                ),
                            }),
                          )
                        }
                      />

                      <button
                        className="horizon-select"
                        onClick={() =>
                          setSelected(
                            h.id,
                          )
                        }
                      >
                        <i
                          style={{
                            background:
                              h.color,
                          }}
                        />

                        <span>
                          {h.name}
                        </span>

                        <ChevronRight
                          size={13}
                        />
                      </button>

                      <button
                        className="icon delete"
                        title={`删除 ${h.name}`}
                        onClick={() =>
                          task(
                            "删除层位…",
                            async () => {
                              await api(
                                "/horizons/" +
                                  h.id,
                                {
                                  method:
                                    "DELETE",
                                },
                              );

                              setView(
                                (v) => ({
                                  ...v,

                                  horizons:
                                    v.horizons.filter(
                                      (a) =>
                                        a.id !==
                                        h.id,
                                    ),
                                }),
                              );
                            },
                          )
                        }
                      >
                        <Trash2
                          size={13}
                        />
                      </button>
                    </div>
                  ),
                )}
              </div>

              <button
                className="secondary full"
                disabled={
                  !meta || !!busy
                }
                onClick={() =>
                  uploadHorizons()
                }
              >
                <Plus size={14} />
                添加层位
              </button>




              {/* ---------------------------------------------------------- */}
              {/* Horizon style editor                                       */}
              {/* ---------------------------------------------------------- */}

              {active && (
                <div className="style-editor">
                  <div className="style-title">
                    <span>
                      {active.name}
                    </span>

                    <input
                      aria-label="层位颜色"
                      type="color"
                      value={
                        active.color
                      }
                      onChange={(e) =>
                        style({
                          color:
                            e.target
                              .value,
                        })
                      }
                    />
                  </div>

                  {view.view_mode ===
                    "3d" && (
                    <Horizon3DControls
                      horizon={active}
                      onChange={style}
                    />
                  )}

                  {(view.view_mode ===
                    "2d" ||
                    active.display_mode ===
                      "slice_intersections") && (
                    <>
                      <Toggle
                        label="显示线条"
                        checked={
                          active.line
                            .visible
                        }
                        onChange={(
                          visible,
                        ) =>
                          style({
                            line: {
                              ...active.line,
                              visible,
                            },
                          })
                        }
                      />

                      <div className="field-row">
                        <label>
                          线型

                          <select
                            value={
                              active.line
                                .style
                            }
                            onChange={(
                              e,
                            ) =>
                              style({
                                line: {
                                  ...active.line,
                                  style:
                                    e
                                      .target
                                      .value,
                                },
                              })
                            }
                          >
                            {[
                              "solid",
                              "dashed",
                              "dotted",
                              "dashdot",
                              "none",
                            ].map((v) => (
                              <option
                                key={v}
                              >
                                {v}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label>
                          线宽 · pt

                          <Num
                            value={
                              active.line
                                .width
                            }
                            min={0.2}
                            max={6}
                            step={0.1}
                            onChange={(
                              width,
                            ) =>
                              style({
                                line: {
                                  ...active.line,
                                  width,
                                },
                              })
                            }
                          />
                        </label>
                      </div>

                      <Toggle
                        label="显示标记点"
                        checked={
                          active.marker
                            .visible
                        }
                        onChange={(
                          visible,
                        ) =>
                          style({
                            marker: {
                              ...active.marker,
                              visible,
                            },
                          })
                        }
                      />

                      <div className="field-row">
                        <label>
                          点形

                          <select
                            value={
                              active.marker
                                .shape
                            }
                            onChange={(
                              e,
                            ) =>
                              style({
                                marker: {
                                  ...active.marker,
                                  shape:
                                    e
                                      .target
                                      .value,
                                },
                              })
                            }
                          >
                            {[
                              "circle",
                              "square",
                              "triangle",
                              "diamond",
                              "cross",
                              "plus",
                              "none",
                            ].map((v) => (
                              <option
                                key={v}
                              >
                                {v}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label>
                          大小 · pt

                          <Num
                            value={
                              active.marker
                                .size
                            }
                            min={1}
                            max={15}
                            onChange={(
                              size,
                            ) =>
                              style({
                                marker: {
                                  ...active.marker,
                                  size,
                                },
                              })
                            }
                          />
                        </label>
                      </div>

                      <div className="section-number">
                        <Toggle
                          label="黑色描边"
                          checked={
                            active.outline
                              .enabled
                          }
                          onChange={(
                            enabled,
                          ) =>
                            style({
                              outline: {
                                ...active.outline,
                                enabled,
                              },
                            })
                          }
                        />

                        <Num
                          value={
                            active.outline
                              .width
                          }
                          min={0}
                          max={4}
                          step={0.1}
                          onChange={(
                            width,
                          ) =>
                            style({
                              outline: {
                                ...active.outline,
                                width,
                              },
                            })
                          }
                        />
                      </div>
                    </>
                  )}
                </div>
              )}
            </Group>
            </div>
          </aside>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Main                                                             */}
        {/* ---------------------------------------------------------------- */}

        <main>
          {/* -------------------------------------------------------------- */}
          {/* Breadcrumb                                                     */}
          {/* -------------------------------------------------------------- */}

          <div className="breadcrumb">
            <button
              className="icon"
              title="收起或展开控制面板"
              onClick={() =>
                setSidebar((s) => !s)
              }
            >
              {sidebar ? (
                <PanelLeftClose
                  size={17}
                />
              ) : (
                <PanelLeftOpen
                  size={17}
                />
              )}
            </button>

            <b>
              {meta
                ? meta.filename
                : "未加载数据"}
            </b>
          </div>

          {/* -------------------------------------------------------------- */}
          {/* Heading                                                        */}
          {/* -------------------------------------------------------------- */}

          <div className="viewer-heading">
            <div>
              <h1>
                {view.view_mode === "map" ? "Horizon Map" : meta
                  ? view.view_mode ===
                    "3d"
                    ? "3D 视图"
                    : `${
                        view.view_type ===
                        "inline"
                          ? "Inline"
                          : "Crossline"
                      } ${
                        view.section_number
                      }`
                  : "地震剖面"}
              </h1>

              {meta && (
                <p>
                  {
                    meta.inlines
                      .length
                  }{" "}
                  Inlines ·{" "}
                  {
                    meta.crosslines
                      .length
                  }{" "}
                  Crosslines ·{" "}
                  {
                    meta.sample_interval
                  }{" "}
                  ms
                </p>
              )}
            </div>
          </div>

          {/* -------------------------------------------------------------- */}
          {/* Error                                                          */}
          {/* -------------------------------------------------------------- */}

          {error && (
            <div
              role="alert"
              className="error"
            >
              <span>{error}</span>

              <button
                className="icon"
                onClick={() =>
                  setError("")
                }
              >
                <X size={14} />
              </button>
            </div>
          )}

          {/* -------------------------------------------------------------- */}
          {/* 3D                                                             */}
          {/* -------------------------------------------------------------- */}

          {view.view_mode === "map" ? (
            <HorizonMap horizons={view.horizons} exportOpen={exportOpen}
              onCloseExport={() => setExportOpen(false)} onReady={setMapReady}
              dataset={dataset} datasetPlaceholder={datasetPlaceholder}
              onDataset={setDataset} onAddToExport={addMapToQueue} />
          ) : view.view_mode === "3d" &&
          meta ? (
            <Scene3D
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
                {/* -------------------------------------------------------- */}
                {/* Toolbar                                                  */}
                {/* -------------------------------------------------------- */}

                <div className="viewer-toolbar">
                  <div />

                  <div className="tools">
                    <button
                      title="框选缩放"
                      className={
                        `icon ` +
                        `${
                          drag === "zoom"
                            ? "chosen"
                            : ""
                        }`
                      }
                      onClick={() =>
                        setDrag("zoom")
                      }
                    >
                      <MousePointer2
                        size={16}
                      />
                    </button>

                    <button
                      title="平移"
                      className={
                        `icon ` +
                        `${
                          drag === "pan"
                            ? "chosen"
                            : ""
                        }`
                      }
                      onClick={() =>
                        setDrag("pan")
                      }
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
                      <RotateCcw
                        size={14}
                      />

                      重置
                    </button>
                  </div>
                </div>

                {/* -------------------------------------------------------- */}
                {/* Plot                                                     */}
                {/* -------------------------------------------------------- */}

                <div className="plot-wrap">
                  {section ? (
                    <div
                      ref={plot}
                      className="plot"
                    />
                  ) : (
                    <div className="empty">
                      <div className="empty-icon">
                        <Activity
                          size={32}
                          strokeWidth={
                            1.5
                          }
                        />
                      </div>

                      <h2>
                        暂无地震数据
                      </h2>

                      <p>
                        导入 SEG-Y
                        文件，或加载 F3
                        示例数据。
                      </p>

                      <div className="empty-actions">
                        <button
                          className="primary"
                          disabled={
                            !!busy
                          }
                          onClick={() =>
                            openSegy()
                          }
                        >
                          <Upload
                            size={15}
                          />

                          导入 SEG-Y
                        </button>

                        <button
                          className="secondary"
                          disabled={
                            !!busy
                          }
                          onClick={
                            loadExample
                          }
                        >
                          <Layers
                            size={15}
                          />

                          加载示例
                        </button>
                      </div>
                    </div>
                  )}

                  {(busy ||
                    loading) && (
                    <div className="loading">
                      <LoaderCircle
                        className="spin"
                        size={17}
                      />

                      {busy ||
                        "提取剖面…"}
                    </div>
                  )}
                </div>

                {/* -------------------------------------------------------- */}
                {/* Viewer bottom                                            */}
                {/* -------------------------------------------------------- */}

                <div className="viewer-bottom">
                  <div className="legend">
                    {view.horizons
                      .filter(
                        (h) =>
                          h.visible,
                      )
                      .map((h) => (
                        <span
                          key={h.id}
                        >
                          <i
                            style={{
                              background:
                                h.color,
                            }}
                          />

                          {h.name}
                        </span>
                      ))}
                  </div>

                  {section && (
                    <div className="amplitude-key">
                      <span>
                        {section.vmin.toPrecision(
                          3,
                        )}
                      </span>

                      <i
                        style={{
                          background:
                            preview,
                        }}
                      />

                      <span>
                        {section.vmax.toPrecision(
                          3,
                        )}
                      </span>

                      <b>振幅</b>
                    </div>
                  )}
                </div>
              </div>

              {/* ---------------------------------------------------------- */}
              {/* Status bar                                                 */}
              {/* ---------------------------------------------------------- */}

              <div className="canvas-footer">
                <span>
                  <MousePointer2
                    size={12}
                  />

                  框选缩放 ·
                  滚轮缩放 ·
                  双击复位
                </span>

                {meta ? (
                  <span>
                    {view.view_type ===
                    "inline"
                      ? `Inline ${view.section_number}`
                      : `Crossline ${view.section_number}`}

                    <span className="dot-separator">
                      ·
                    </span>

                    {view.view_type ===
                    "inline"
                      ? `Crossline ${meta.crosslines[0]}–${meta.crosslines.at(-1)}`
                      : `Inline ${meta.inlines[0]}–${meta.inlines.at(-1)}`}

                    <span className="dot-separator">
                      ·
                    </span>

                    TWT{" "}
                    {
                      meta
                        .time_range[0]
                    }
                    –
                    {
                      meta.time_range[
                        1
                      ]
                    }{" "}
                    ms
                  </span>
                ) : (
                  <span>
                    未加载数据
                  </span>
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

      {exportOpen &&
        view.view_mode === "3d" && (
          <Export3DDialog
            scene={view.scene}
            busy={busy}
            error={error}
            dataset={dataset}
            datasetPlaceholder={datasetPlaceholder}
            onDataset={setDataset}
            onClose={() =>
              setExportOpen(false)
            }
            onExport={add3DToQueue}
          />
        )}

      {/* ------------------------------------------------------------------ */}
      {/* 2D export                                                          */}
      {/* ------------------------------------------------------------------ */}

      {exportOpen && view.view_mode === "2d" && (
        <ExportDialog title="二维剖面 · Add to Export" settings={settings}
          onChange={p => setSettings(s => ({...s, ...p}))}
          onClose={() => setExportOpen(false)} onExport={add2DToQueue}
          dataset={dataset} datasetPlaceholder={datasetPlaceholder} onDataset={setDataset}
          busy={!!busy} disabled={loading} error={error} />
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
        onExportAll={exportAll}
      />

      {horizonImport && (
        <div
          className="modal-backdrop"
          onClick={() => !busy && setHorizonImport(null)}
        >
          <div
            className="modal horizon-import-modal"
            role="dialog"
            aria-modal="true"
            aria-label="选择层位列"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <h2>选择层位列</h2>
              <button
                className="icon"
                disabled={!!busy}
                onClick={() => setHorizonImport(null)}
              >
                <X size={20} />
              </button>
            </div>

            <div className="import-file-name">
              {horizonImport.filename}
            </div>

            <div className="column-selects">
              {(
                [
                  ["inline_column", "Inline"],
                  ["xline_column", "Xline"],
                  ["time_column", "Time / TWT"],
                ] as const
              ).map(([key, label]) => (
                <label className="field" key={key}>
                  {label}
                  <select
                    value={horizonImport[key]}
                    onChange={(e) =>
                      setHorizonImport((current) =>
                        current
                          ? {
                              ...current,
                              [key]: Number(e.target.value),
                            }
                          : current,
                      )
                    }
                  >
                    {horizonImport.columns.map((column) => (
                      <option key={column.index} value={column.index}>
                        {column.index + 1}: {column.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>

            <div className="column-preview" aria-label="层位数据预览">
              <div
                className="column-preview-row column-preview-header"
                style={{
                  gridTemplateColumns: `repeat(${horizonImport.columns.length}, minmax(100px, 1fr))`,
                }}
              >
                {horizonImport.columns.map((column) => (
                  <span key={column.index}>
                    {column.index + 1}. {column.name}
                  </span>
                ))}
              </div>
              {horizonImport.rows.map((row, rowIndex) => (
                <div
                  className="column-preview-row"
                  key={rowIndex}
                  style={{
                    gridTemplateColumns: `repeat(${horizonImport.columns.length}, minmax(100px, 1fr))`,
                  }}
                >
                  {horizonImport.columns.map((column) => (
                    <span key={column.index}>
                      {row[column.index] || "—"}
                    </span>
                  ))}
                </div>
              ))}
            </div>

            <div className="import-actions">
              <button
                className="secondary"
                disabled={!!busy}
                onClick={() => setHorizonImport(null)}
              >
                取消
              </button>
              <button
                className="primary"
                disabled={
                  !!busy ||
                  new Set([
                    horizonImport.inline_column,
                    horizonImport.xline_column,
                    horizonImport.time_column,
                  ]).size !== 3
                }
                onClick={importHorizon}
              >
                {busy || "确认并导入"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
