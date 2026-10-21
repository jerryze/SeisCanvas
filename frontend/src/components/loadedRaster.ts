type Range = readonly number[];
export type RasterCoverage = {
  raster_extent?: readonly number[];
  preview_shape?: readonly number[];
};

/** Compare physical coverage and actual sample density, not request equality. */
export function coversViewport(
  data: RasterCoverage,
  x: Range | null,
  time: Range | null,
  width: number,
  height: number,
  interpolate: boolean,
  overlays: boolean,
) {
  if (overlays || !x || !time || !data.raster_extent) return false;
  const [left, right, top, bottom] = data.raster_extent;
  const xmin = Math.min(...x),
    xmax = Math.max(...x),
    tmin = Math.min(...time),
    tmax = Math.max(...time);
  if (
    ![left, right, top, bottom, xmin, xmax, tmin, tmax, width, height].every(
      Number.isFinite,
    ) ||
    right <= left ||
    bottom <= top ||
    xmax <= xmin ||
    tmax <= tmin ||
    width <= 0 ||
    height <= 0
  )
    return false;
  const epsilon = 1e-7;
  if (
    xmin < left - epsilon ||
    xmax > right + epsilon ||
    tmin < top - epsilon ||
    tmax > bottom + epsilon
  )
    return false;
  // Exact native cells retain their precision at any zoom within coverage.
  if (!interpolate) return true;
  const [rows, columns] = data.preview_shape ?? [];
  if (!(rows > 0 && columns > 0)) return false;
  // Match the backend's interactive pixel and dimension limits. Allow one
  // pixel of rounding, never silently reuse a lower-resolution zoom level.
  const dimensionScale = Math.min(1, 8000 / Math.max(width, height));
  width = Math.max(1, Math.floor(width * dimensionScale));
  height = Math.max(1, Math.floor(height * dimensionScale));
  const budgetScale = Math.min(1, Math.sqrt(600000 / (width * height)));
  const requiredWidth = Math.max(1, Math.floor(width * budgetScale));
  const requiredHeight = Math.max(1, Math.floor(height * budgetScale));
  return (
    (columns * (xmax - xmin)) / (right - left) + 1 >= requiredWidth &&
    (rows * (tmax - tmin)) / (bottom - top) + 1 >= requiredHeight
  );
}

/** Only return changed layout fields, so a committed drag is not drawn twice. */
export function layoutPatch(current: any, requested: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(requested)
      .filter(([key, value]) => {
        const previous = key
          .split(".")
          .reduce((object, part) => object?.[part], current);
        const equal = (a: unknown, b: unknown) =>
          typeof a === "number" && typeof b === "number"
            ? Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
            : a === b;
        return Array.isArray(value)
          ? !Array.isArray(previous) ||
              value.length !== previous.length ||
              value.some((v, i) => !equal(v, previous[i]))
          : !equal(value, previous);
      })
      .map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
  );
}
