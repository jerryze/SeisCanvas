/** Plotly 3.7 gl-plot3d adapter. Keep private renderer access isolated here.
 * Reuses GPU objects; never calls Plotly.react/newPlot/toImage or the backend.
 */
import type { Camera, Export3D } from "../../types";
import { contentBounds } from "./exportCrop";
import { suppressJunctionOverlaps } from "./axisJunctions";
import { applyTimeAxisTitleRotation } from "./axisTitles";

type Matrix = ArrayLike<number>;
type Bounds = number[][];
export type Timing = Record<string, number>;
type Rect = { x: number; y: number; width: number; height: number };
const axisKeys = [
  "enable",
  "tickFont",
  "labelFont",
  "tickSize",
  "labelSize",
  "tickColor",
  "labelColor",
  "lineColor",
  "lineWidth",
  "tickPad",
  "labelPad",
  "lineTickLength",
  "labelEnable",
  "labels",
  "tickEnable",
  "lineEnable",
  "gridEnable",
  "lineTickEnable",
];

function transform(matrix: Matrix, v: number[]) {
  return [0, 1, 2, 3].map((r) =>
    v.reduce((sum, n, c) => sum + matrix[c * 4 + r] * n, 0),
  );
}

/** Conservative clipped actor bounds in the *current* camera projection.
 * Screen aspect cancels out when this rectangle becomes the new viewport. */
export function projectedBounds(
  bounds: Bounds[],
  model: Matrix,
  view: Matrix,
  projection: Matrix,
  width: number,
  height: number,
  padding: number,
): Rect {
  const points: number[][] = [];
  for (const box of bounds) {
    if (!box?.flat().every(Number.isFinite)) continue;
    const corners = Array.from({ length: 8 }, (_, i) =>
      transform(
        projection,
        transform(
          view,
          transform(model, [
            box[i & 1][0],
            box[(i >> 1) & 1][1],
            box[(i >> 2) & 1][2],
            1,
          ]),
        ),
      ),
    );
    // Clip every bounding-box edge to the near plane before perspective divide.
    for (let i = 0; i < 8; i++)
      for (const bit of [1, 2, 4]) {
        if (i & bit) continue;
        let a = corners[i],
          b = corners[i | bit];
        const da = a[2] + a[3],
          db = b[2] + b[3];
        if (da < 0 && db < 0) continue;
        if (da < 0 || db < 0) {
          const t = da / (da - db);
          const cut = a.map((n, j) => n + t * (b[j] - n));
          if (da < 0) a = cut;
          else b = cut;
        }
        for (const v of [a, b])
          if (v[3] > 1e-8)
            points.push([
              Math.max(0, Math.min(width, ((v[0] / v[3] + 1) * width) / 2)),
              Math.max(0, Math.min(height, ((1 - v[1] / v[3]) * height) / 2)),
            ]);
      }
  }
  if (!points.length) throw new Error("场景没有可保存的可见内容。");
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  const x = Math.min(...xs) - padding,
    y = Math.min(...ys) - padding;
  return {
    x,
    y,
    width: Math.max(...xs) + padding - x,
    height: Math.max(...ys) + padding - y,
  };
}

/** Off-axis crop of the projection, preserving geometry/camera and pixel scale. */
export function cropProjection(
  projection: Matrix,
  rect: Rect,
  width: number,
  height: number,
) {
  const out = Array.from(projection);
  const sx = width / rect.width,
    sy = height / rect.height;
  const tx = (width - 2 * rect.x - rect.width) / rect.width;
  const ty = (rect.height + 2 * rect.y - height) / rect.height;
  for (let c = 0; c < 4; c++) {
    out[c * 4] = sx * projection[c * 4] + tx * projection[c * 4 + 3];
    out[c * 4 + 1] = sy * projection[c * 4 + 1] + ty * projection[c * 4 + 3];
  }
  return out;
}

/** Convert WebGL bottom-up, premultiplied RGBA in one linear pass. */
export function unpackPixels(
  source: Uint8Array,
  width: number,
  height: number,
) {
  const target = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const from = ((height - 1 - y) * width + x) * 4,
        to = (y * width + x) * 4;
      const a = source[from + 3];
      target[to + 3] = a;
      if (a)
        for (let c = 0; c < 3; c++)
          target[to + c] = Math.min(
            255,
            Math.round((source[from + c] * 255) / a),
          );
    }
  return target;
}

const paint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
const now = () => performance.now();

export async function captureScene(
  element: any,
  settings: Export3D,
  status: (message: string) => void = () => {},
) {
  const start = now(),
    timings: Timing = {};
  const scene = element?._fullLayout?.scene?._scene;
  const renderer = scene?.glplot;
  if (
    !renderer?.gl ||
    !renderer.cameraParams?.projection ||
    typeof renderer.redraw !== "function"
  )
    throw new Error("当前三维渲染器无法生成图件，请刷新页面后重试。");
  if (renderer.contextLost || renderer.gl.isContextLost())
    throw new Error("三维显卡上下文已丢失，请重新加载场景。");
  status("准备三维图件…");
  await document.fonts.load(
    `${(settings.font_size * 4) / 3}px "${settings.font}"`,
  );
  const gl = renderer.gl as WebGLRenderingContext,
    canvas = renderer.canvas as HTMLCanvasElement;
  const axes = renderer.axes;
  applyTimeAxisTitleRotation(axes);
  const camera: Camera = structuredClone(scene.getCamera());
  const saved = {
    width: canvas.width,
    height: canvas.height,
    pixelRatio: renderer.pixelRatio,
    autoResize: renderer.autoResize,
    onrender: renderer.onrender,
    clearColor: renderer.clearColor,
    selection: renderer.selection.object,
    axes: Object.fromEntries(
      axisKeys.map((k) => [k, structuredClone(axes[k])]),
    ),
    objects: renderer.objects.slice(),
  };
  const boxObjects: any[] = [];
  for (const trace of Object.values(scene.traces) as any[])
    if (trace.data?.meta?.exportRole === "boundingBox")
      for (const object of [trace.linePlot, trace.scatterPlot])
        if (object) boxObjects.push(object);
  const cssWidth = saved.width / saved.pixelRatio,
    cssHeight = saved.height / saved.pixelRatio;
  const params = renderer.cameraParams;
  const originalProjection = Array.from(params.projection) as number[];
  const font = (settings.font_size * 4) / 3;
  // Axes' tick/label offsets are outside actor bounds; allow a font-aware guard.
  const labelPadding = Math.max(
    ...[0, 1, 2].map(
      (i) =>
        (axes.tickPad?.[i] ?? 10) +
        (settings.show_axis_labels ? (axes.labelPad?.[i] ?? 30) : 0),
    ),
  );
  const guard = settings.show_axes ? Math.max(42, labelPadding + font * 2) : 8;
  const actorBounds = saved.objects
    .filter((o: any) => !boxObjects.includes(o) || settings.show_bounding_box)
    .map((o: any) => o.bounds);
  if (settings.show_axes || settings.show_bounding_box)
    actorBounds.push(renderer.bounds);
  const rect =
    settings.canvas === "fixed"
      ? { x: 0, y: 0, width: cssWidth, height: cssHeight }
      : projectedBounds(
          actorBounds,
          params.model,
          params.view,
          originalProjection,
          cssWidth,
          cssHeight,
          guard,
        );
  const longEdge = settings.long_edge ?? 3000;
  const scale = longEdge / Math.max(rect.width, rect.height);
  const width = Math.max(64, Math.round(rect.width * scale));
  const height = Math.max(64, Math.round(rect.height * scale));
  const limit = Math.min(
    gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    gl.getParameter(gl.MAX_TEXTURE_SIZE),
  );
  if (width > limit || height > limit)
    throw new Error("图件尺寸超出显卡支持范围，请减小长边。");
  const projection = cropProjection(
    originalProjection,
    rect,
    cssWidth,
    cssHeight,
  );
  timings.scene_preparation = now() - start;
  status(`渲染三维 · ${width} × ${height} px`);
  await paint();
  let pixels: Uint8Array;
  let restoreAxisText = () => {};
  try {
    const presentationStart = now();
    // All edits below are temporary presentation/resolution state. No object,
    // colormap, geometry buffer, texture, or camera is replaced.
    renderer.autoResize = false;
    renderer.pixelRatio = scale;
    renderer.selection.object = null;
    renderer.clearColor = [0, 0, 0, 0];
    renderer.onrender = () => {
      for (let i = 0; i < 16; i++) params.projection[i] = projection[i];
    };
    if (settings.show_axes) restoreAxisText = suppressJunctionOverlaps(axes);
    axes.update({
      tickFont: settings.font,
      labelFont: settings.font,
      tickSize: font,
      labelSize: font,
      tickColor: [0, 0, 0, 1],
      labelColor: [0, 0, 0, 1],
      lineColor: [0, 0, 0, 1],
      lineWidth: (0.8 * 4) / 3,
      // gl-axes3d computes label offsets assuming an uncropped projection.
      // Counteract the off-axis magnification, especially in orthographic views.
      tickPad: (saved.axes.tickPad ?? [10, 10, 10]).map(
        (v: number) => (v * rect.height) / cssHeight,
      ),
      labelPad: (saved.axes.labelPad ?? [30, 30, 30]).map(
        (v: number) => (v * rect.height) / cssHeight,
      ),
      lineTickLength: (saved.axes.lineTickLength ?? [5, 5, 5]).map(
        (v: number) => (v * rect.height) / cssHeight,
      ),
      labels: ["Crossline", "Inline", "Time (ms)"],
      tickEnable: true,
      lineEnable: true,
      gridEnable: true,
      lineTickEnable: true,
      labelEnable: [0, 1, 2].map(() => settings.show_axis_labels),
    });
    axes.enable = settings.show_axes;
    for (const object of boxObjects)
      object._exportVisible = settings.show_bounding_box;
    canvas.width = width;
    canvas.height = height;
    timings.scene_preparation += now() - presentationStart;
    const renderStart = now();
    renderer.redraw();
    gl.finish(); // Attribute GPU work to render, rather than hiding it in readback.
    timings.render_3d = now() - renderStart;
    const readStart = now();
    pixels = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    timings.image_readback = now() - readStart;
  } finally {
    const restoreStart = now();
    restoreAxisText();
    renderer.autoResize = saved.autoResize;
    renderer.pixelRatio = saved.pixelRatio;
    renderer.clearColor = saved.clearColor;
    renderer.selection.object = saved.selection;
    renderer.onrender = saved.onrender;
    for (const object of boxObjects) delete object._exportVisible;
    axes.update(saved.axes);
    axes.enable = saved.axes.enable;
    canvas.width = saved.width;
    canvas.height = saved.height;
    renderer.redraw();
    timings.restore = now() - restoreStart;
  }
  const cropStart = now();
  const rgba = unpackPixels(pixels!, width, height);
  const crop =
    settings.canvas === "fixed"
      ? { x: 0, y: 0, width, height }
      : contentBounds(rgba, width, height, Math.max(4, Math.ceil(6 * scale)));
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  source
    .getContext("2d")!
    .putImageData(new ImageData(rgba, width, height), 0, 0);
  const output = document.createElement("canvas");
  // Keep the requested long edge; only remove unused rows/columns on the
  // shorter edge. No high-resolution raster is ever scaled down or up.
  output.width =
    crop.width >= crop.height
      ? longEdge
      : Math.max(64, Math.min(width, crop.width));
  output.height =
    crop.height > crop.width
      ? longEdge
      : Math.max(64, Math.min(height, crop.height));
  const context = output.getContext("2d")!;
  if (settings.format !== "png" || settings.background !== "transparent") {
    context.fillStyle = "white";
    context.fillRect(0, 0, output.width, output.height);
  }
  context.drawImage(
    source,
    -crop.x + Math.floor((output.width - crop.width) / 2),
    -crop.y + Math.floor((output.height - crop.height) / 2),
  );
  timings.crop = now() - cropStart;
  status(`编码 PNG · ${output.width} × ${output.height} px`);
  const encodeStart = now();
  const png = await new Promise<string>((resolve, reject) =>
    output.toBlob((blob) => {
      if (!blob) return reject(new Error("PNG 编码失败。"));
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("读取图件失败。"));
      reader.readAsDataURL(blob);
    }, "image/png"),
  );
  timings.png_encoding = now() - encodeStart;
  timings.total = now() - start;
  timings.high_resolution_renders = 1;
  console.info("SeisCanvas 3D export " + JSON.stringify(timings));
  return {
    png,
    format: settings.format,
    width_px: output.width,
    height_px: output.height,
    scale: 1,
    pixel_size: [output.width, output.height] as [number, number],
    render_dpi: 96 * scale,
    camera,
    timings,
  };
}
