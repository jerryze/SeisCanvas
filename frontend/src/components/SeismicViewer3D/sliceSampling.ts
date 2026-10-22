import type { Camera } from "../../types";

export type SliceViewports = Record<string, [number, number]>;
type Vector = { x: number; y: number; z: number };
type SamplingBasis = {
  projection: "perspective" | "orthographic";
  widthDemand: number;
  heightDemand: number;
};
export type SliceSamplingState = {
  viewports: SliceViewports;
  basis?: SamplingBasis;
};
export type SliceSamplingObservation = {
  camera: Camera;
  width: number;
  height: number;
  /** Plotly implements orthographic wheel zoom by scaling this aspect ratio. */
  aspectRatio?: Vector;
  viewports: SliceViewports;
  /** Supply current visible IDs to discard old/hidden slice allocations. */
  sliceIds?: readonly string[];
  /** Trace spacing follows CSS pixels, so zooming out must also resample. */
  traceOverlays?: boolean;
};

// A full sampling request is more expensive than keeping a slightly oversized
// texture. Accumulate small zoom/resize steps until demand has grown by 25%.
const GROWTH = 1.25;
const MIN_SIZE = 32;
const MAX_SIZE = 16000;
const validSize = (value: number) => Number.isFinite(value) && value > 0;

function samplingBasis(observation: SliceSamplingObservation): SamplingBasis | undefined {
  const { camera, width, height, aspectRatio } = observation;
  if (!validSize(width) || !validSize(height)) return;
  const distance = Math.hypot(camera.eye.x - camera.center.x,
    camera.eye.y - camera.center.y, camera.eye.z - camera.center.z);
  if (!validSize(distance)) return;
  const projection = camera.projection?.type ?? "perspective";
  // Orbit preserves eye-to-center distance, and pan translates both points.
  // Neither operation should spend another request on projected plane spans.
  // Orthographic zoom also changes the scene's common aspect scale in Plotly.
  const aspectScale = aspectRatio
    ? Math.hypot(aspectRatio.x, aspectRatio.y, aspectRatio.z) / Math.sqrt(3)
    : 1;
  if (!validSize(aspectScale)) return;
  const zoom = aspectScale / distance;
  return { projection, widthDemand: width * zoom, heightDemand: height * zoom };
}

function viewportSize(value: number) {
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.ceil(value / MIN_SIZE) * MIN_SIZE));
}

/** Select display resolutions without changing slice coordinates or source
 * ranges. Only zoom/resize demand can change existing allocations: projecting
 * a rotated or panned plane alone never invalidates its loaded texture.
 * Background textures retain their resolution; trace overlays may shrink too
 * because their native trace spacing follows display pixels. */
export function advanceSliceSampling(
  previous: SliceSamplingState | null,
  observation: SliceSamplingObservation,
): SliceSamplingState {
  const current = previous ?? { viewports: {} };
  const nextBasis = samplingBasis(observation);
  const projectionChanged = !!current.basis && !!nextBasis &&
    current.basis.projection !== nextBasis.projection;
  const demandGrew = !!nextBasis && !!current.basis && !projectionChanged &&
    (nextBasis.widthDemand >= current.basis.widthDemand * GROWTH ||
      nextBasis.heightDemand >= current.basis.heightDemand * GROWTH);
  const demandShrank = !!observation.traceOverlays && !!nextBasis &&
    !!current.basis && !projectionChanged &&
    (nextBasis.widthDemand <= current.basis.widthDemand / GROWTH ||
      nextBasis.heightDemand <= current.basis.heightDemand / GROWTH);
  const mayGrow = !current.basis || demandGrew;
  const visible = observation.sliceIds ? new Set(observation.sliceIds) : null;
  const viewports: SliceViewports = {};
  let changed = false;
  for (const [id, sizes] of Object.entries(current.viewports)) {
    if (visible && !visible.has(id)) changed = true;
    else viewports[id] = sizes;
  }
  for (const [id, sizes] of Object.entries(observation.viewports)) {
    if ((visible && !visible.has(id)) || !sizes.every(validSize)) continue;
    const requested: [number, number] = [viewportSize(sizes[0]), viewportSize(sizes[1])];
    const existing = viewports[id];
    if (!existing) {
      viewports[id] = requested;
      changed = true;
    } else if (mayGrow || demandShrank) {
      const next: [number, number] = [
        (requested[0] >= existing[0] * GROWTH && mayGrow) ||
          (requested[0] <= existing[0] / GROWTH && demandShrank)
          ? requested[0] : existing[0],
        (requested[1] >= existing[1] * GROWTH && mayGrow) ||
          (requested[1] <= existing[1] / GROWTH && demandShrank)
          ? requested[1] : existing[1],
      ];
      if (next[0] !== existing[0] || next[1] !== existing[1]) {
        viewports[id] = next;
        changed = true;
      }
    }
  }
  // Projection presets establish a fresh demand baseline while retaining the
  // loaded textures. Sampling need is compared only within one projection.
  const basis = nextBasis && (!current.basis || projectionChanged || demandGrew || demandShrank)
    ? nextBasis : current.basis;
  return changed || basis !== current.basis
    ? { viewports: changed ? viewports : current.viewports, basis }
    : current;
}
