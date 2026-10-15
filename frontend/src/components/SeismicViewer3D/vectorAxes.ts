/** Plotly 3.7 gl-axes3d: keep its native glyph and line geometry as vectors.
 * Captures the final shader draw calls; PNG continues to use the WebGL axes.
 */
import { project, textAngle } from "./axisJunctions";
import { readShaderUniforms } from "./shaderUniforms";

export type VectorPath = {
  points: [number, number][];
  color: string;
  opacity: number;
  layer: "back" | "front";
};
export type VectorOverlay = {
  paths: VectorPath[];
  lines: { points: [number, number][]; color: string; width: number; opacity?: number; layer?: "back" | "front" }[];
  labels: string[];
};
const MAX_PATHS = 50_000;
const triangle = [[0, 0, 1], [0, 1, 1], [0, 0, -1], [0, 0, -1], [0, 1, 1], [0, 1, -1]];

/** Preserve WebGL viewport clipping before measuring or packaging vectors. */
export function clipToViewport(points: [number, number][], width: number, height: number) {
  let clipped = points;
  for (const [axis, boundary, direction] of [[0, 0, 1], [0, width, -1], [1, 0, 1], [1, height, -1]]) {
    const output: [number, number][] = [];
    if (!clipped.length) break;
    let previous = clipped.at(-1)!;
    let previousInside = direction * (previous[axis] - boundary) >= 0;
    for (const point of clipped) {
      const inside = direction * (point[axis] - boundary) >= 0;
      if (inside !== previousInside) {
        const ratio = (boundary - previous[axis]) / (point[axis] - previous[axis]);
        output.push([previous[0] + ratio * (point[0] - previous[0]), previous[1] + ratio * (point[1] - previous[1])]);
      }
      if (inside) output.push(point);
      previous = point; previousInside = inside;
    }
    clipped = output;
  }
  return clipped;
}

function clipPosition(point: number[], uniforms: any) {
  let v = [...point, 1];
  for (const matrix of [uniforms.model, uniforms.view, uniforms.projection])
    v = [0, 1, 2, 3].map(r => v.reduce((sum, n, c) => sum + matrix[c * 4 + r] * n, 0));
  const w = Math.max(v[3], 0.0001);
  return [v[0] / w, v[1] / w, v[2] / w];
}

/** Mirror the pinned text shader, including the camera-dependent title angle. */
export function projectGlyph(vertex: number[], uniforms: any): [number, number] | null {
  const point = uniforms.offset.map((v: number, i: number) => v + vertex[2] * uniforms.axis[i]);
  const clip = clipPosition(point, uniforms);
  if (clip[2] < -1 || clip[2] > 1) return null;
  const origin = project(point, uniforms);
  const beta = textAngle(point, uniforms.axis, uniforms.alignDir, uniforms.alignOpt, uniforms.angle, uniforms);
  const scale = uniforms.scale * uniforms.pixelScale;
  return [
    origin[0] + scale * (Math.cos(beta) * vertex[0] - Math.sin(beta) * vertex[1]),
    origin[1] - scale * (Math.sin(beta) * vertex[0] + Math.cos(beta) * vertex[1]),
  ];
}

/** Mirror the native line shader's projected quad, including its pixel width. */
export function projectLineVertex(vertex: number[], uniforms: any): [number, number] | null {
  const point = uniforms.offset.map((v: number, i: number) =>
    v + vertex[0] * uniforms.majorAxis[i] + vertex[1] * uniforms.minorAxis[i]);
  const clip = clipPosition(point, uniforms);
  if (clip[2] < -1 || clip[2] > 1) return null;
  const end = clipPosition(point.map((v: number, i: number) => v + uniforms.screenAxis[i] * vertex[2]), uniforms);
  const width = uniforms.screenShape[0], height = uniforms.screenShape[1];
  const dx = (end[0] - clip[0]) * width, dy = (end[1] - clip[1]) * height;
  const length = Math.hypot(dx, dy);
  if (!length) return null;
  return [
    (clip[0] + 1) * width / 2 + dx / length * uniforms.lineWidth / 4,
    (1 - clip[1]) * height / 2 - dy / length * uniforms.lineWidth / 4,
  ];
}

function lineVertices(axes: any, lines: any) {
  const count = Math.max(6, ...[0, 1, 2].map(axis => lines.gridOffset[axis] + lines.gridCount[axis]));
  const vertices = new Float32Array(count * 3);
  vertices.set(triangle.flat());
  for (const axis of [0, 1, 2])
    for (const offset of [lines.tickOffset[axis], lines.gridOffset[axis]])
      axes.ticks[axis].forEach((tick: any, index: number) => {
        vertices.set(triangle.flatMap(v => [tick.x, v[1], v[2]]), (offset + index * 6) * 3);
      });
  return vertices;
}

/** Install before export axes.update. Restore before interactive redraw. */
export function captureVectorAxes(axes: any) {
  const overlay: VectorOverlay = { paths: [], lines: [], labels: [] };
  const restores: (() => void)[] = [];
  const patched = new WeakSet<object>();
  const update = axes.update;
  let layer: "back" | "front" = "front";
  function append(vertices: ArrayLike<number>, count: number, offset: number, uniforms: any, glyph: boolean) {
    const color = uniforms.color;
    if (!color?.[3]) return;
    const hex = "#" + Array.from(color as ArrayLike<number>).slice(0, 3).map((v: number) =>
      Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
    for (let i = offset; i < offset + count; i += 3) {
      const points = [i, i + 1, i + 2].map(index => {
        const vertex = Array.from({ length: 3 }, (_, c) => vertices[index * 3 + c]);
        return glyph ? projectGlyph(vertex, uniforms) : projectLineVertex(vertex, uniforms);
      });
      if (points.some(point => !point?.every(Number.isFinite))) continue;
      const shape = glyph ? uniforms.resolution : uniforms.screenShape;
      const clipped = clipToViewport(points as [number, number][], shape[0], shape[1]);
      if (clipped.length < 3) continue;
      if (overlay.paths.length >= MAX_PATHS) throw new Error("坐标矢量内容超出导出限制，请减少图件尺寸。");
      overlay.paths.push({ points: clipped, color: hex, opacity: color[3], layer: glyph ? "front" : layer });
    }
  }
  function ensureAdapters() {
    const text = axes._text, lines = axes._lines;
    if (!text?.buffer?.update || !text?.vao?.draw || !text?.shader?.uniforms ||
        !lines?.vao?.draw || !lines?.shader?.uniforms)
      throw new Error("当前三维渲染器无法导出矢量坐标，请刷新页面后重试。");
    if (!patched.has(text)) {
      patched.add(text);
      const upload = text.buffer.update, draw = text.vao.draw;
      let vertices: ArrayLike<number> = [];
      text.buffer.update = function (data: ArrayLike<number>, ...args: any[]) {
        vertices = Float32Array.from(data);
        return upload.call(this, data, ...args);
      };
      text.vao.draw = function (_mode: number, count: number, offset = 0) {
        append(vertices, count, offset, readShaderUniforms(text.shader, [
          "model", "view", "projection", "resolution", "pixelScale", "offset", "axis",
          "alignDir", "alignOpt", "angle", "scale", "color",
        ]), true);
      };
      restores.push(() => { text.buffer.update = upload; text.vao.draw = draw; });
      // Capture even when the requested font already matches the on-screen font.
      const fonts = (prefix: string) => [0, 1, 2].map(i => ({
        family: axes[prefix + "Font"][i], style: axes[prefix + "FontStyle"][i],
        weight: axes[prefix + "FontWeight"][i], variant: axes[prefix + "FontVariant"][i],
      }));
      text.update(axes.bounds, axes.labels, fonts("label"), axes.ticks, fonts("tick"));
    }
    if (!patched.has(lines)) {
      patched.add(lines);
      const vertices = lineVertices(axes, lines), draw = lines.vao.draw;
      lines.vao.draw = function (_mode: number, count: number, offset = 0) {
        append(vertices, count, offset, readShaderUniforms(lines.shader, [
          "model", "view", "projection", "offset", "majorAxis", "minorAxis",
          "screenAxis", "screenShape", "lineWidth", "color",
        ]), false);
      };
      restores.push(() => { lines.vao.draw = draw; });
      for (const method of ["drawAxisLine", "drawAxisTicks", "drawGrid", "drawZero"]) {
        const original = lines[method];
        lines[method] = function (...args: any[]) {
          const previous = layer;
          layer = method === "drawGrid" || method === "drawZero" ? "back" : "front";
          try { return original.apply(this, args); } finally { layer = previous; }
        };
        restores.push(() => { lines[method] = original; });
      }
    }
    overlay.labels = [...new Set([
      ...axes.labels.filter((_v: string, i: number) => axes.labelEnable[i]),
      ...axes.ticks.flatMap((ticks: any[], i: number) => axes.tickEnable[i] ? ticks.map(tick => String(tick.text ?? "")) : []),
    ])].filter(Boolean) as string[];
  }
  axes.update = function (...args: any[]) {
    const result = update.apply(this, args);
    ensureAdapters();
    return result;
  };
  try { ensureAdapters(); } catch (error) {
    axes.update = update;
    for (const restore of restores.reverse()) restore();
    throw error;
  }
  return {
    overlay,
    restore() {
      axes.update = update;
      for (const restore of restores.reverse()) restore();
    },
  };
}

export function translateVectorOverlay(overlay: VectorOverlay, x: number, y: number): VectorOverlay {
  const translate = (points: [number, number][]) => points.map(([px, py]) => [px + x, py + y] as [number, number]);
  return {
    paths: overlay.paths.map(path => ({ ...path, points: translate(path.points) })),
    lines: overlay.lines.map(line => ({ ...line, points: translate(line.points) })),
    labels: overlay.labels,
  };
}
