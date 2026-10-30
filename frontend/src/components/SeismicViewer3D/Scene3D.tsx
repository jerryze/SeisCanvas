import { captureScene, type Timing, type VectorOverlay } from "./captureScene";
import {
  forwardRef,
  useState,
  useEffect,
  useRef,
  useImperativeHandle,
} from "react";
import Plotly from "plotly.js-dist-min";
import { applyDepthLayers } from "./depthLayers";
import { applyTimeAxisTitleRotation } from "./axisTitles";
import { applySurfaceLighting } from "./surfaceLighting";
import { measureSliceViewports } from "./sliceViewport";
import { sceneCameraKey } from "./sceneCamera";
import { advanceSliceSampling, type SliceSamplingState, type SliceViewports } from "./sliceSampling";
import {
  LoaderCircle,
  RotateCcw,
  Move,
  Orbit,
  Box,
} from "lucide-react";
import { VS, Meta, Camera, Export3D, perspective } from "../../types";
import { SceneData, buildTraces, buildLayout } from "./sceneGeometry";
import { useOriginalProbe, ProbeReadout } from "../Probe";
import { api } from "../../api/client";
import { formatAmplitude } from "../../format";
/** A finalised WebGL capture, ready to be stored in the export session. */
export type Scene3DCapture = {
  png: string;
  format: "png" | "pdf" | "svg";
  width_px: number;
  height_px: number;
  scale: number;
  pixel_size: [number, number];
  render_dpi?: number;
  camera: Camera;
  timings: Timing;
  vector_overlay?: VectorOverlay;
};
export type Scene3DHandle = {
  captureFigure: (settings: Export3D, onStatus?: (message: string) => void) => Promise<Scene3DCapture>;
};
type Props = {
  view: VS;
  meta: Meta;
  hasSeismic: boolean;
  maps: Record<string, any[]>;
  revision: number;
  busy?: string;
  onCamera: (camera: Camera) => void;
  onError: (message: string) => void;
  onReady: (ready: boolean) => void;
};
const presets: Record<string, Camera> = {
  Perspective: perspective,
  Top: {
    eye: { x: 0, y: 0, z: 1.55 },
    up: { x: 0, y: 1, z: 0 },
    center: { x: 0, y: 0, z: 0 },
    projection: { type: "orthographic" },
  },
  Inline: {
    eye: { x: 0, y: -1.65, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    center: { x: 0, y: 0, z: 0 },
    projection: { type: "orthographic" },
  },
  Crossline: {
    eye: { x: 1.65, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    center: { x: 0, y: 0, z: 0 },
    projection: { type: "orthographic" },
  },
};
const Scene3D = forwardRef<Scene3DHandle, Props>(function Scene3D(
  { view, meta, hasSeismic, maps, revision, busy = "", onCamera, onError, onReady },
  ref,
) {
  const plot = useRef<HTMLDivElement>(null),
    [data, setData] = useState<SceneData | null>(null),
    [loading, setLoading] = useState(true),
    [rendering, setRendering] = useState(true),
    [drag, setDrag] = useState<"orbit" | "pan">("orbit");
  const { reading: probe, probe: runProbe, reset: resetProbe } = useOriginalProbe();
  const probeRef = useRef(runProbe);
  probeRef.current = runProbe;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const latest = useRef({ view, onCamera, onError, onReady });
  latest.current = { view, onCamera, onError, onReady };
  const dataRef = useRef(data);
  dataRef.current = data;
  const renderQueue = useRef(Promise.resolve());
  const renderVersion = useRef(0);
  const exporting = useRef(false);
  const [exportStatus, setExportStatus] = useState("");
  const [sliceViewports, setSliceViewports] = useState<SliceViewports>({});
  const sampling = useRef<SliceSamplingState | null>(null);
  const acceptedSampling = useRef<SliceSamplingState | null>(null);
  const samplingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interaction = useRef({ pointer: false, time: 0 });
  const mounted = useRef(true);
  const plotUpdating = useRef(false);
  const resizePending = useRef(false);
  const accepted = useRef<{ query: string; meta: Meta; revision: number } | null>(null);
  const backgroundData = useRef<SceneData | null>(null);
  const renderedStyle = useRef("");
  const displayedAspect = useRef("");
  const IDLE_DELAY = 500;

  function liveCamera(): Camera {
    return structuredClone((plot.current as any)?._fullLayout?.scene?._scene?.getCamera?.()
      || latest.current.view.scene.camera);
  }
  function scheduleSampling() {
    if (samplingTimer.current) clearTimeout(samplingTimer.current);
    if (!mounted.current) return;
    samplingTimer.current = setTimeout(() => {
      samplingTimer.current = null;
      const el = plot.current as any;
      const current = latest.current.view;
      if (!mounted.current || !dataRef.current || dataRef.current.has_seismic === false || !el || loadingRef.current ||
          plotUpdating.current || exporting.current || interaction.current.pointer) return;
      if (!current.seismic.background_interpolation && !current.seismic.wiggle && !current.seismic.variable_area) return;
      const gl = el._fullLayout?.scene?._scene?.glplot;
      const previous = sampling.current;
      const next = advanceSliceSampling(previous, {
        camera: liveCamera(), width: el.clientWidth, height: el.clientHeight,
        aspectRatio: gl?.getAspectratio?.(),
        sliceIds: dataRef.current.slices.map(plane => plane.id),
        traceOverlays: current.seismic.wiggle || current.seismic.variable_area,
        viewports: measureSliceViewports(el, dataRef.current),
      });
      sampling.current = next;
      if (next.viewports !== previous?.viewports && Object.keys(next.viewports).length)
        setSliceViewports(next.viewports);
    }, IDLE_DELAY);
  }
  // Reuse the renderer's live camera and orthographic wheel scale for data and
  // style updates. An explicitly requested preset still takes precedence.
  function currentRenderView() {
    const current = latest.current.view;
    const requested = sceneCameraKey(current.scene.camera) !== displayedCamera.current;
    const aspect = (plot.current as any)?._fullLayout?.scene?._scene?.glplot?.getAspectratio?.();
    const retainAspect = !requested && displayedAspect.current === JSON.stringify(current.scene.aspect_ratio) &&
      aspect && [aspect.x, aspect.y, aspect.z].every((n: number) => Number.isFinite(n) && n > 0);
    return { ...current, scene: { ...current.scene,
      camera: requested ? structuredClone(current.scene.camera) : liveCamera(),
      aspect_ratio: retainAspect ? [aspect.x, aspect.y, aspect.z] as [number, number, number] : current.scene.aspect_ratio,
    } };
  }
  function attachEvents(el: any) {
    el.removeAllListeners?.("plotly_relayout");
    el.removeAllListeners?.("plotly_relayouting");
    el.removeAllListeners?.("plotly_webglcontextlost");
    el.removeAllListeners?.("plotly_hover");
    const activeCamera = (event: any, persist: boolean) => {
      if (exporting.current || (!event["scene.camera"] && !event["scene.aspectratio"])) return;
      interaction.current.time = Date.now();
      if (persist) {
        const camera = event["scene.camera"] ? structuredClone(event["scene.camera"]) : liveCamera();
        const key = sceneCameraKey(camera);
        if (key !== displayedCamera.current) {
          displayedCamera.current = key;
          // Async data responses can run before React commits this gesture.
          latest.current.view = { ...latest.current.view, scene: { ...latest.current.view.scene, camera } };
          latest.current.onCamera(camera);
        }
      }
      scheduleSampling();
    };
    el.on("plotly_relayout", (event: any) => activeCamera(event, true));
    el.on("plotly_relayouting", (event: any) => activeCamera(event, false));
    el.on("plotly_hover", (event: any) => {
      if (dataRef.current?.has_seismic === false) return;
      const point = event?.points?.[0];
      const info = point?.data?.meta?.probe;
      if (!info) return;
      const { kind, position } = info;
      if (kind === "time") probeRef.current({ kind, position, crossline: point.x, inline: point.y });
      else if (kind === "inline") probeRef.current({ kind, position, crossline: point.x, time: point.z });
      else probeRef.current({ kind, position, inline: point.y, time: point.z });
    });
    el.on("plotly_webglcontextlost", () => {
      latest.current.onReady(false);
      latest.current.onError("三维显卡上下文丢失，请减少切片或降低精度后重新进入 3D。");
    });
  }
  function resizePlot() {
    const el = plot.current as any;
    if (!el?.data || !mounted.current) return;
    resizePending.current = true;
    if (exporting.current) return;
    renderQueue.current = renderQueue.current.catch(() => {}).then(async () => {
      if (!mounted.current || exporting.current || !resizePending.current) return;
      resizePending.current = false;
      plotUpdating.current = true;
      try { await Plotly.Plots.resize(el); }
      finally { plotUpdating.current = false; scheduleSampling(); }
    }).catch(e => { if (mounted.current) latest.current.onError(String(e)); });
  }
  const displayedCamera = useRef("");
  // Saving an orbit must not rebuild surfaces or temporarily cover the canvas.
  const sceneStyle = JSON.stringify({
    ...view,
    scene: { ...view.scene, camera: undefined },
  });
  const cameraKey = sceneCameraKey(view.scene.camera);
  // Scientific changes load normally. Camera-driven sampling has a separate,
  // quiet request after interaction stops; orbit/pan keep the same allocations.
  const query = JSON.stringify({
    slices: Object.fromEntries(
      Object.entries(view.slices).map(([k, s]) => [
        k,
        s
          .filter((p) => p.visible)
          .map((p) => ({ id: p.id, position: p.position })),
      ]),
    ),
    horizons: view.horizons
      .filter((h) => h.visible)
      .map((h) => ({
        id: h.id,
        display_mode: h.display_mode,
        amplitude: h.color_by === "amplitude",
        time_slice_tolerance: h.time_slice_tolerance,
      })),
    seismic: {
      clip_mode: view.seismic.clip_mode,
      clip_percentile: view.seismic.clip_percentile,
      symmetric: view.seismic.symmetric,
      vmin: view.seismic.vmin,
      vmax: view.seismic.vmax,
      reverse_polarity: view.seismic.reverse_polarity,
      background_interpolation: view.seismic.background_interpolation,
      wiggle_interpolation: view.seismic.wiggle_interpolation,
      wiggle: view.seismic.wiggle,
      variable_area: view.seismic.variable_area,
      wiggle_gain: view.seismic.wiggle_gain,
    },
    quality: view.scene.quality,
  });
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    let applyTimer: ReturnType<typeof setTimeout> | null = null;
    const previous = accepted.current;
    const background = !!dataRef.current && previous?.query === query && previous.meta === meta && previous.revision === revision;
    const requestedSampling = sampling.current;
    if (!background) {
      setLoading(true);
      loadingRef.current = true;
      renderVersion.current++;
      latest.current.onReady(false);
    }
    const timer = setTimeout(async () => {
      try {
        const response = await api("/scene", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...latest.current.view, view_mode: "3d",
            scene: { ...latest.current.view.scene, slice_viewports: sliceViewports } }),
          signal: abort.signal,
        });
        const next: SceneData = await response.json();
        if (!active) return;
        if (next.has_seismic !== false && next.slices.some(plane => plane.background_interpolation !== latest.current.view.seismic.background_interpolation))
          throw new Error("三维显示版本不匹配，请重启 SeisCanvas。");
        if (next.has_seismic !== false && latest.current.view.horizons.some(h => h.visible && h.display_mode === "full_surface"
          && h.color_by === "amplitude" && !next.horizons[h.id]?.mesh?.amplitude))
          throw new Error("三维层位版本不匹配，请重启 SeisCanvas。");
        const apply = () => {
          if (!active) return;
          const wait = IDLE_DELAY - (Date.now() - interaction.current.time);
          if (background && (wait > 0 || interaction.current.pointer || exporting.current || plotUpdating.current)) {
            applyTimer = setTimeout(apply, Math.max(80, wait));
            return;
          }
          accepted.current = { query, meta, revision };
          acceptedSampling.current = requestedSampling;
          backgroundData.current = background ? next : null;
          setData(next);
          latest.current.onError("");
          if (!background) { setLoading(false); loadingRef.current = false; }
        };
        apply();
      } catch (e) {
        if (!active || (e as Error).name === "AbortError") return;
        if (background) sampling.current = acceptedSampling.current;
        else { setData(null); setRendering(false); setLoading(false); loadingRef.current = false; }
        latest.current.onError((e as Error).message);
      }
    }, background ? 0 : 140);
    return () => {
      active = false;
      clearTimeout(timer);
      if (applyTimer) clearTimeout(applyTimer);
      abort.abort();
    };
  }, [query, sliceViewports, meta, revision]);
  useEffect(() => {
    if (!plot.current || !data || loading) return;
    const el = plot.current as any;
    const version = ++renderVersion.current;
    const quiet = backgroundData.current === data && renderedStyle.current === sceneStyle;
    if (!quiet) { setRendering(true); latest.current.onReady(false); }
    renderQueue.current = renderQueue.current.catch(() => {}).then(async () => {
      if (version !== renderVersion.current || !mounted.current) return;
      plotUpdating.current = true;
      try {
        const current = currentRenderView();
        await Plotly.react(el, buildTraces(data, current, maps, undefined, true),
          buildLayout(data, current, drag) as any, {
            responsive: false, displayModeBar: false, scrollZoom: true,
            plotGlPixelRatio: Math.min(window.devicePixelRatio, 2),
          });
        if (version !== renderVersion.current || !mounted.current) return;
        applySurfaceLighting(el);
        applyTimeAxisTitleRotation(el._fullLayout?.scene?._scene?.glplot?.axes);
        applyDepthLayers(el);
        displayedCamera.current = sceneCameraKey(liveCamera());
        displayedAspect.current = JSON.stringify(latest.current.view.scene.aspect_ratio);
        renderedStyle.current = sceneStyle;
        if (backgroundData.current === data) backgroundData.current = null;
        attachEvents(el);
        setRendering(false);
        latest.current.onReady(!loadingRef.current);
      } finally { plotUpdating.current = false; scheduleSampling(); }
    }).catch(e => {
      if (!mounted.current || version !== renderVersion.current) return;
      setRendering(false);
      latest.current.onReady(false);
      latest.current.onError(String(e));
    });
  }, [data, sceneStyle, maps, drag, loading]);
  useEffect(() => {
    if (loading || rendering || !data || cameraKey === displayedCamera.current) return;
    const el = plot.current as any;
    if (!el) return;
    const requestedCamera = structuredClone(view.scene.camera);
    const requestedKey = cameraKey;
    const version = renderVersion.current;
    renderQueue.current = renderQueue.current
      .catch(() => {})
      .then(async () => {
        if (version !== renderVersion.current || !mounted.current || !el.isConnected || requestedKey === displayedCamera.current || requestedKey !== sceneCameraKey(latest.current.view.scene.camera)) return;
        // Projection changes recreate Plotly's GL scene. Supplying geometry in
        // the same update prevents a new scene containing only the axis objects.
        // Mouse orbit events already update displayedCamera and skip this path.
        const current = latest.current.view;
        const next = { ...current, scene: { ...current.scene, camera: requestedCamera } };
        plotUpdating.current = true;
        try {
          await Plotly.react(el, buildTraces(data, next, maps, undefined, true),
            buildLayout(data, next, drag) as any, {
              responsive: false, displayModeBar: false, scrollZoom: true,
              plotGlPixelRatio: Math.min(window.devicePixelRatio, 2),
            });
          if (version !== renderVersion.current || !mounted.current) return;
          applySurfaceLighting(el);
          applyTimeAxisTitleRotation(el._fullLayout?.scene?._scene?.glplot?.axes);
          applyDepthLayers(el);
          displayedCamera.current = requestedKey;
          displayedAspect.current = JSON.stringify(latest.current.view.scene.aspect_ratio);
        } finally { plotUpdating.current = false; scheduleSampling(); }
      })
      .catch((e) => {
        if (mounted.current && version === renderVersion.current) latest.current.onError(String(e));
      });
  }, [cameraKey, loading, rendering, data, maps, drag]);
  useEffect(() => {
    resetProbe();
  }, [data]);
  useEffect(() => {
    const el = plot.current;
    if (!el) return;
    mounted.current = true;
    let width = el.clientWidth, height = el.clientHeight;
    const touch = () => { interaction.current.time = Date.now(); scheduleSampling(); };
    const down = () => { interaction.current.pointer = true; touch(); };
    const up = () => { if (interaction.current.pointer) { interaction.current.pointer = false; touch(); } };
    el.addEventListener("pointerdown", down, { passive: true });
    el.addEventListener("wheel", touch, { passive: true });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", up);
    const observer = new ResizeObserver(() => {
      if (width === el.clientWidth && height === el.clientHeight) return;
      width = el.clientWidth; height = el.clientHeight;
      resizePlot();
    });
    observer.observe(el);
    return () => {
      mounted.current = false;
      observer.disconnect();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("wheel", touch);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", up);
      if (samplingTimer.current) clearTimeout(samplingTimer.current);
      renderVersion.current++;
      renderQueue.current.finally(() => Plotly.purge(el));
    };
  }, []);
  useImperativeHandle(
    ref,
    () => ({
      captureFigure: async (settings, onStatus) => {
        if (!dataRef.current || loading || rendering || exporting.current)
          throw new Error("请等待三维场景加载或图件保存完成。");
        exporting.current = true;
        try {
          // Reserve the queue slot before awaiting it. Subsequent edits must
          // run after GPU capture and interactive-size restoration complete.
          const capture = renderQueue.current.catch(() => {}).then(() => {
            if (!mounted.current || !plot.current) throw new Error("三维视图已关闭。");
            return captureScene(plot.current, settings, message => {
              setExportStatus(message);
              onStatus?.(message);
            });
          });
          renderQueue.current = capture.then(() => {}, () => {});
          return await capture;
        } finally {
          exporting.current = false;
          setExportStatus("");
          if (resizePending.current) resizePlot();
          scheduleSampling();
        }
      },
    }),
    [data, loading, rendering, maps, drag],
  );
  const count = Object.values(view.slices)
    .flat()
    .filter((s) => s.visible).length;
  return (
    <>
      <div className="viewer-card scene-card">
        <div className="viewer-toolbar scene-toolbar">
          <div className="viewer-label">
            <Box size={15} />
            <span>三维切片组合</span>
            <span className="tag">{count} 切片</span>
          </div>
          <div className="scene-presets" role="group" aria-label="三维视角">
            {Object.keys(presets).map((name) => (
              <button
                key={name}
                onClick={() => onCamera(structuredClone(presets[name]))}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="tools">
            <button
              className={`icon ${drag === "orbit" ? "chosen" : ""}`}
              title="旋转场景"
              onClick={() => setDrag("orbit")}
            >
              <Orbit size={16} />
            </button>
            <button
              className={`icon ${drag === "pan" ? "chosen" : ""}`}
              title="平移场景"
              onClick={() => setDrag("pan")}
            >
              <Move size={16} />
            </button>
            <button
              className="reset"
              onClick={() => onCamera(structuredClone(perspective))}
            >
              <RotateCcw size={14} />
              重置相机
            </button>
          </div>
        </div>
        <div className="plot-wrap scene-plot-wrap">
          <div ref={plot} className="plot" />
          {(loading || rendering || exportStatus || busy) && (
            <div className="loading" role="status" aria-live="polite">
              <LoaderCircle className="spin" size={16} />
              {exportStatus || busy || (loading ? "正在提取切片与层位…" : "正在绘制三维场景…")}
            </div>
          )}
          {!loading && !data && (
            <div className="scene-no-data">
              场景加载失败
            </div>
          )}
          {!loading &&
            data &&
            !count &&
            !view.horizons.some(
              (h) => h.visible && h.display_mode === "full_surface",
            ) && (
              <div className="scene-hint">
                暂无三维内容
              </div>
            )}
        </div>
        {hasSeismic && data?.has_seismic !== false && (
          <div className="viewer-bottom" role="region" aria-label="坐标与振幅读数" tabIndex={0}>
            <ProbeReadout reading={probe} />
            {data?.vmin != null && data.vmax != null && (
              <div className="amplitude-key">
                <b>共享振幅</b>
                <span>
                  {formatAmplitude(data.vmin)} … {formatAmplitude(data.vmax)}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
});
export default Scene3D;
