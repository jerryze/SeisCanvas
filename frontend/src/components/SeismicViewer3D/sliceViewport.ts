import { project } from "./axisJunctions";
import { planePoint, type SceneData } from "./sceneGeometry";
import { readShaderUniforms } from "./shaderUniforms";

/** Project source-plane spans with Plotly's current matrices. Geometry stays
 * in physical coordinates; these CSS sizes only select display resolution and
 * the native trace interval. Quantization avoids requests for camera jitter. */
export function measureSliceViewports(element: any, data: SceneData) {
  const scene = element?._fullLayout?.scene?._scene;
  const axes = scene?.glplot?.axes;
  const matrices = readShaderUniforms(axes?._lines?.shader, ["model", "view", "projection"]);
  const gl = scene?.glplot?.gl;
  if (!matrices?.model || !matrices?.view || !matrices?.projection || !gl ||
      !element.clientWidth || !element.clientHeight) return {};
  const uniforms = { model: matrices.model, view: matrices.view, projection: matrices.projection,
    resolution: [element.clientWidth, element.clientHeight] };
  const scale = scene.dataScale || [1, 1, 1];
  const dimension = (value: number) => Math.max(32, Math.min(16000, Math.round(value / 32) * 32));
  const viewports: Record<string, [number, number]> = {};
  for (const plane of data.slices) {
    const aa = plane.source_a_range || [plane.a[0], plane.a.at(-1)!];
    const bb = plane.source_b_range || [plane.b[0], plane.b.at(-1)!];
    const at = (a: number, b: number) => project(planePoint(plane, a, b).map((v, n) => v * scale[n]), uniforms);
    const length = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const width = Math.max(...[bb[0], (bb[0] + bb[1]) / 2, bb[1]].map(b => length(at(aa[0], b), at(aa[1], b))));
    const height = Math.max(...[aa[0], (aa[0] + aa[1]) / 2, aa[1]].map(a => length(at(a, bb[0]), at(a, bb[1]))));
    if (Number.isFinite(width) && Number.isFinite(height)) viewports[plane.id] = [dimension(width), dimension(height)];
  }
  return viewports;
}
