export type HorizonCurveViewport = {
  width: number;
  xRange: readonly number[];
  pixelRatio?: number;
};

/** Shape-preserving PCHIP slopes (weighted harmonic means and one-sided ends). */
function slopes(points: number[][]): number[] {
  const n = points.length;
  const dx = points.slice(1).map((p, i) => p[0] - points[i][0]);
  const secant = points.slice(1).map((p, i) => (p[1] - points[i][1]) / dx[i]);
  if (n === 2) return [secant[0], secant[0]];
  const end = (h0: number, h1: number, d0: number, d1: number) => {
    const m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (Math.sign(m) !== Math.sign(d0)) return 0;
    return Math.sign(d0) !== Math.sign(d1) && Math.abs(m) > 3 * Math.abs(d0) ? 3 * d0 : m;
  };
  const m = [end(dx[0], dx[1], secant[0], secant[1])];
  for (let i = 1; i < n - 1; i++) {
    const a = secant[i - 1], b = secant[i];
    const w1 = 2 * dx[i] + dx[i - 1], w2 = dx[i] + 2 * dx[i - 1];
    m.push(a === 0 || b === 0 || Math.sign(a) !== Math.sign(b)
      ? 0 : (w1 + w2) / (w1 / a + w2 / b));
  }
  m.push(end(dx[n - 2], dx[n - 3], secant[n - 2], secant[n - 3]));
  return m;
}

/** Display-only points: retain every original knot and gap, never round TWT.
 * Insert at most one point per device pixel across the visible x range.
 * Derivatives use the full segment so zooming does not change its shape.
 */
export function horizonCurve(points: number[][], viewport: HorizonCurveViewport): number[][] {
  const lo = Math.min(...viewport.xRange), hi = Math.max(...viewport.xRange);
  const pixels = Math.min(32000, Math.ceil(viewport.width * (viewport.pixelRatio || 1)));
  if (!(hi > lo) || !Number.isFinite(pixels) || pixels < 1) return points;
  const step = (hi - lo) / pixels;
  const result: number[][] = [];
  let segment: number[][] = [];
  function flush() {
    // Conflicting duplicate x values cannot define a single-valued PCHIP.
    // Preserve their original connections rather than averaging/deleting picks.
    if (segment.length < 2 || segment.some((p, i) => i > 0 && p[0] <= segment[i - 1][0])) {
      for (const point of segment) result.push(point);
      segment = [];
      return;
    }
    const m = slopes(segment);
    result.push(segment[0]);
    for (let i = 0; i < segment.length - 1; i++) {
      const [x0, y0] = segment[i], [x1, y1] = segment[i + 1];
      const h = x1 - x0;
      const start = Math.max(0, Math.floor((x0 - lo) / step) + 1);
      const stop = Math.min(pixels, Math.ceil((x1 - lo) / step) - 1);
      for (let j = start; j <= stop; j++) {
        const x = lo + j * step;
        if (x <= x0 || x >= x1) continue;
        const t = (x - x0) / h, t2 = t * t, t3 = t2 * t;
        const y = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m[i]
          + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m[i + 1];
        result.push([x, y]);
      }
      result.push(segment[i + 1]);
    }
    segment = [];
  }
  for (const p of points) {
    if (Number.isFinite(p[0]) && Number.isFinite(p[1])) segment.push(p);
    else { flush(); result.push(p); }
  }
  flush();
  return result;
}
