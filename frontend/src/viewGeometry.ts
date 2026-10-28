import type { Meta, SliceKind, VS } from "./types";

/** Horizon-only geometry has no sampling interval; its time coordinates stay continuous. */
export function geometryTimeCenter(meta: Meta) {
  return meta.samples > 0 && meta.sample_interval > 0
    ? meta.time_range[0] + Math.round((meta.samples - 1) / 2) * meta.sample_interval
    : (meta.time_range[0] + meta.time_range[1]) / 2;
}

export function geometryPositions(meta: Meta, kind: SliceKind): number[] {
  if (kind === "inline") return meta.inlines;
  if (kind === "crossline") return meta.crosslines;
  return meta.samples > 0 && meta.sample_interval > 0
    ? Array.from({ length: meta.samples }, (_, i) => meta.time_range[0] + i * meta.sample_interval)
    : meta.time_range;
}

export function snapGeometryPosition(meta: Meta, kind: SliceKind, value: number) {
  if (kind === "time" && !meta.samples)
    return Math.max(meta.time_range[0], Math.min(meta.time_range[1], value));
  const positions = geometryPositions(meta, kind);
  return positions.reduce((a, b) => Math.abs(b - value) < Math.abs(a - value) ? b : a);
}

/** Keep scientific coordinates valid when imported/deleted horizons change the bounds. */
export function reconcileViewGeometry(view: VS, meta: Meta, hasSeismic: boolean): VS {
  const section = snapGeometryPosition(meta, view.view_type, view.section_number);
  const outside = (range: [number, number] | null, bounds: number[]) =>
    !!range && (range[1] < bounds[0] || range[0] > bounds.at(-1)!);
  const horizontal = view.view_type === "inline" ? meta.crosslines : meta.inlines;
  const slices = Object.fromEntries(Object.entries(view.slices).map(([kind, items]) => [kind,
    items.map(slice => ({ ...slice, position: snapGeometryPosition(meta, kind as SliceKind, slice.position) })),
  ])) as VS["slices"];
  return {
    ...view, section_number: section, slices,
    x_range: section !== view.section_number || outside(view.x_range, horizontal) ? null : view.x_range,
    time_range: section !== view.section_number || outside(view.time_range, meta.time_range) ? null : view.time_range,
    horizons: hasSeismic ? view.horizons : view.horizons.map(h =>
      h.color_by === "amplitude" ? { ...h, color_by: "twt" } : h),
  };
}
