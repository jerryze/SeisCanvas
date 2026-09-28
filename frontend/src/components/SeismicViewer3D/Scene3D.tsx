import {
  forwardRef,
  useState,
  useEffect,
  useRef,
  useImperativeHandle,
} from "react";
import Plotly from "plotly.js-dist-min";
import { applyDepthLayers } from "./depthLayers";
import {
  LoaderCircle,
  RotateCcw,
  Move,
  Orbit,
  Box,
} from "lucide-react";
import { VS, Meta, Camera, Export3D, perspective, exportPixels, MAX_SCENE_PIXELS } from "../../types";
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
};
export type Scene3DHandle = {
  captureFigure: (settings: Export3D) => Promise<Scene3DCapture>;
};
type Props = {
  view: VS;
  meta: Meta;
  maps: Record<string, any[]>;
  revision: number;
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
  { view, meta, maps, revision, onCamera, onError, onReady },
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
  const displayedCamera = useRef("");
  // Saving an orbit must not rebuild surfaces or temporarily cover the canvas.
  const sceneStyle = JSON.stringify({
    ...view,
    scene: { ...view.scene, camera: undefined },
  });
  const cameraKey = JSON.stringify(view.scene.camera);
  // Style/camera changes never trigger a data request. Hidden slices and horizons are omitted.
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
        time_slice_tolerance: h.time_slice_tolerance,
      })),
    seismic: {
      clip_mode: view.seismic.clip_mode,
      clip_percentile: view.seismic.clip_percentile,
      symmetric: view.seismic.symmetric,
      vmin: view.seismic.vmin,
      vmax: view.seismic.vmax,
      reverse_polarity: view.seismic.reverse_polarity,
    },
    quality: view.scene.quality,
  });
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    setLoading(true);
    renderVersion.current++;
    latest.current.onReady(false);
    const timer = setTimeout(async () => {
      try {
        const response = await api("/scene", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...latest.current.view, view_mode: "3d" }),
          signal: abort.signal,
        });
        const next = await response.json();
        if (active) {
          setData(next);
          latest.current.onError("");
        }
      } catch (e) {
        if (active && (e as Error).name !== "AbortError") {
          setData(null);
          setRendering(false);
          latest.current.onError((e as Error).message);
        }
      } finally {
        if (active) setLoading(false);
      }
    }, 140);
    return () => {
      active = false;
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, meta, revision]);
  useEffect(() => {
    if (!plot.current || !data || loading) return;
    const el = plot.current as any;
    const version = ++renderVersion.current;
    setRendering(true);
    latest.current.onReady(false);
    renderQueue.current = renderQueue.current
      .catch(() => {})
      .then(async () => {
        if (version !== renderVersion.current) return;
        el.removeAllListeners?.("plotly_relayout");
        el.removeAllListeners?.("plotly_webglcontextlost");
        el.removeAllListeners?.("plotly_hover");
        await Plotly.react(
          el,
          buildTraces(data, latest.current.view, maps),
          buildLayout(data, latest.current.view, drag) as any,
          {
            responsive: true,
            displayModeBar: false,
            scrollZoom: true,
            plotGlPixelRatio: Math.min(window.devicePixelRatio, 2),
          },
        );
        if (version !== renderVersion.current) return;
        applyDepthLayers(el);
        displayedCamera.current = JSON.stringify(latest.current.view.scene.camera);
        el.on("plotly_relayout", (event: any) => {
          if (event["scene.camera"]) {
            displayedCamera.current = JSON.stringify(event["scene.camera"]);
            latest.current.onCamera(event["scene.camera"]);
          }
        });
        // Slice textures are resampled for display, so the amplitude readout
        // asks the backend for the original sample under the cursor.
        el.on("plotly_hover", (event: any) => {
          const point = event?.points?.[0];
          const info = point?.data?.meta?.probe;
          if (!info) return;
          const { kind, position } = info;
          if (kind === "time") {
            probeRef.current({ kind, position, crossline: point.x, inline: point.y });
          } else if (kind === "inline") {
            probeRef.current({ kind, position, crossline: point.x, time: point.z });
          } else {
            probeRef.current({ kind, position, inline: point.y, time: point.z });
          }
        });
        el.on("plotly_webglcontextlost", () => {
          latest.current.onReady(false);
          latest.current.onError(
            "三维显卡上下文丢失，请减少切片或降低精度后重新进入 3D。",
          );
        });
        setRendering(false);
        latest.current.onReady(!loadingRef.current);
      })
      .catch((e) => {
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
        if (version !== renderVersion.current || !el.isConnected) return;
        // Projection changes recreate Plotly's GL scene. Supplying geometry in
        // the same update prevents a new scene containing only the axis objects.
        // Mouse orbit events already update displayedCamera and skip this path.
        const current = latest.current.view;
        const next = { ...current, scene: { ...current.scene, camera: requestedCamera } };
        await Plotly.react(el, buildTraces(data, next, maps),
          buildLayout(data, next, drag) as any, {
            responsive: true, displayModeBar: false, scrollZoom: true,
            plotGlPixelRatio: Math.min(window.devicePixelRatio, 2),
          });
        applyDepthLayers(el);
        displayedCamera.current = requestedKey;
      })
      .catch((e) => latest.current.onError(String(e)));
  }, [cameraKey, loading, rendering, data, maps, drag]);
  useEffect(() => {
    resetProbe();
  }, [data]);
  useEffect(() => {
    const el = plot.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if ((el as any).data) Plotly.Plots.resize(el);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      renderVersion.current++;
      renderQueue.current.finally(() => Plotly.purge(el));
    };
  }, []);
  useImperativeHandle(
    ref,
    () => ({
      captureFigure: async (settings) => {
        if (!dataRef.current || loading || rendering)
          throw new Error("请等待三维场景加载完成。");
        const { width, height, scale, pixels } = exportPixels(settings);
        if (pixels[0] * pixels[1] > MAX_SCENE_PIXELS)
          throw new Error(
            `三维栅格渲染上限为 ${MAX_SCENE_PIXELS / 1_000_000} 百万像素，请减小尺寸或降低 DPI。`,
          );
        const el = document.createElement("div");
        el.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;height:${height}px;`;
        document.body.appendChild(el);
        try {
          await document.fonts.load(
            `${(settings.font_size * 4) / 3}px "${settings.font}"`,
          );
          const current = latest.current.view;
          // Publication capture re-reads the slices at the best texture quality
          // and with the requested interpolation instead of reusing the
          // interactive texture. Falls back to the browsed scene on failure.
          let scene = dataRef.current;
          const publication = {
            ...current,
            scene: { ...current.scene, quality: 512 as const },
            seismic: { ...current.seismic, interpolation: settings.interpolation },
          };
          if (
            current.scene.quality < 512 ||
            current.seismic.interpolation !== settings.interpolation
          ) {
            try {
              scene = await (
                await api("/scene", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(publication),
                })
              ).json();
            } catch {
              /* Keep the browsed texture when the extra read fails. */
            }
          }
          await Plotly.newPlot(
            el,
            buildTraces(scene, current, maps, settings),
            {
              ...buildLayout(scene, current, drag, settings),
              width,
              height,
              autosize: false,
            } as any,
            { displayModeBar: false, plotGlPixelRatio: scale },
          );
          applyDepthLayers(el);
          const png = await Plotly.toImage(el, {
            format: "png",
            width,
            height,
            scale,
          });
          return {
            png,
            format: settings.format,
            width_px: width,
            height_px: height,
            scale,
            pixel_size: [width * scale, height * scale] as [number, number],
          };
        } finally {
          Plotly.purge(el);
          el.remove();
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
        <div className="viewer-toolbar">
          <div className="viewer-label">
            <Box size={15} />
            <span>三维切片组合</span>
            <span className="tag">{count} 切片</span>
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
        <div className="scene-presets">
          {Object.keys(presets).map((name) => (
            <button
              key={name}
              onClick={() => onCamera(structuredClone(presets[name]))}
            >
              {name}
            </button>
          ))}
          <span>X · Crossline / Y · Inline / Z · TWT ↓</span>
        </div>
        <div className="plot-wrap scene-plot-wrap">
          <div ref={plot} className="plot" />
          {(loading || rendering) && (
            <div className="loading">
              <LoaderCircle className="spin" size={16} />
              {loading ? "正在提取切片与层位…" : "正在绘制三维场景…"}
            </div>
          )}
          {!loading && !data && (
            <div className="scene-no-data">
              场景加载失败，请检查提示并调整设置。
            </div>
          )}
          {!loading &&
            data &&
            !count &&
            !view.horizons.some(
              (h) => h.visible && h.display_mode === "full_surface",
            ) && (
              <div className="scene-hint">
                从左侧添加切片，或启用完整层位曲面
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
                  {h.name}{h.display_mode === "full_surface" && h.twt_range ? ` · ${h.twt_range[0].toFixed(1)}–${h.twt_range[1].toFixed(1)} ms` : ""} ·{" "}
                  {h.display_mode === "full_surface" ? "曲面" : "交线"}
                </span>
              ))}
          </div>
          {data && (
            <div className="amplitude-key">
              <span>
                {formatAmplitude(data.vmin)} … {formatAmplitude(data.vmax)}
              </span>
              <b>共享振幅范围</b>
            </div>
          )}
        </div>
      </div>
      <div className="canvas-footer">
        <span>拖动旋转 · 滚轮缩放 · 平移工具移动场景</span>
      </div>
    </>
  );
});
export default Scene3D;
