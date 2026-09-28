export type HS = {
  color_by: "twt" | "solid";
  horizon_colormap: "petrel";
  smooth_shading: boolean;
  lighting: boolean;
  twt_range: [number, number] | null;
  display_mode: "full_surface" | "slice_intersections";
  opacity: number;
  surface_mode: "surface" | "wireframe" | "surface_wireframe";
  wireframe_width: number;
  time_slice_tolerance: number;
  id: string;
  name: string;
  visible: boolean;
  color: string;
  line: { visible: boolean; width: number; style: string };
  marker: { visible: boolean; shape: string; size: number };
  outline: { enabled: boolean; width: number };
};
export type SS = {
  colormap: string;
  reverse_colormap: boolean;
  clip_mode: string;
  clip_percentile: number;
  symmetric: boolean;
  vmin: number | null;
  vmax: number | null;
  reverse_polarity: boolean;
};
export type VS = {
  view_mode: "2d" | "3d" | "map";
  slices: SliceCollection;
  scene: SceneSettings;
  view_type: "inline" | "crossline";
  section_number: number;
  x_range: [number, number] | null;
  time_range: [number, number] | null;
  aspect_ratio_2d: [number, number] | null;
  seismic: SS;
  horizons: HS[];
};
export type Meta = {
  filename: string;
  inlines: number[];
  crosslines: number[];
  samples: number;
  sample_interval: number;
  time_range: number[];
  traces: number;
};
export type Section = {
  x: number[];
  time: number[];
  z: number[][];
  vmin: number;
  vmax: number;
  horizons: Record<string, number[][]>;
};

export type SliceKind = "inline" | "crossline" | "time";
export type Slice = {
  id: string;
  position: number;
  visible: boolean;
  opacity: number;
  border: { visible: boolean; color: string; width: number };
};
export type SliceCollection = Record<SliceKind, Slice[]>;
export type Camera = {
  eye: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  center: { x: number; y: number; z: number };
  projection?: { type: "perspective" | "orthographic" };
};
export type SceneSettings = {
  show_axes: boolean;
  show_axis_labels: boolean;
  show_bounding_box: boolean;
  aspect_ratio: [number, number, number];
  quality: 128 | 256 | 512;
  background: string;
  camera: Camera;
};
export type Export3D = {
  format: "png" | "pdf" | "svg";
  font: string;
  font_size: number;
  /** Physical page size in millimetres, like the 2D export. */
  width: number;
  height: number;
  dpi: 300 | 600;
  background: string;
  show_axes: boolean;
  show_axis_labels: boolean;
  show_bounding_box: boolean;
};
/** A WebGL figure is rasterised: derive the layout pixels and the device scale. */
export function exportPixels(settings: {
  width: number;
  height: number;
  dpi: number;
}) {
  const scale = settings.dpi >= 600 ? 4 : 3;
  const width = Math.max(
    64,
    Math.round(((settings.width / 25.4) * settings.dpi) / scale),
  );
  const height = Math.max(
    64,
    Math.round(((settings.height / 25.4) * settings.dpi) / scale),
  );
  return { width, height, scale, pixels: [width * scale, height * scale] as const };
}
export const MAX_SCENE_PIXELS = 24_000_000;

/** An immutable figure already rendered and stored in the export session. */
export type ExportItem = {
  id: string;
  index: number;
  dataset: string;
  view_type: string;
  folder: string;
  filename: string;
  format: string;
  width_mm: number | null;
  height_mm: number | null;
  dpi: number | null;
  pixel_size: [number, number] | null;
  scale: number | null;
  size_bytes: number;
  created_at: string;
  detail: string;
};
export type ExportQueueState = {
  session: string;
  dataset: string | null;
  count: number;
  items: ExportItem[];
};
export const perspective: Camera = {
  eye: { x: 1.25, y: 1.25, z: 0.9 },
  up: { x: 0, y: 0, z: 1 },
  center: { x: 0, y: 0, z: 0 },
  projection: { type: "perspective" },
};
export const defaultScene: SceneSettings = {
  show_axes: true,
  show_axis_labels: true,
  show_bounding_box: true,
  aspect_ratio: [1, 1, 0.7],
  quality: 256,
  background: "#ffffff",
  camera: perspective,
};
export const makeSlice = (position: number): Slice => ({
  id: crypto.randomUUID(),
  position,
  visible: true,
  opacity: 1,
  border: { visible: true, color: "#000000", width: 1 },
});
