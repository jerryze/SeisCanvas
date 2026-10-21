export type Range = [number, number];

export function ordered(range: Range): Range {
  return [Math.min(...range), Math.max(...range)];
}

/** Keep the visible span while preventing navigation beyond the data edges. */
export function scrollWindow(
  bounds: Range,
  range: Range,
  fraction: number,
  reverse = false,
): Range {
  const [min, max] = ordered(bounds);
  const span = Math.min(max - min, Math.abs(range[1] - range[0]));
  const position = Math.max(0, Math.min(1, fraction));
  const start = min + (max - min - span) * (reverse ? 1 - position : position);
  const result: Range = [start, start + span];
  return range[0] > range[1] ? [result[1], result[0]] : result;
}

/** Minimum thumb size affects hit testing only, never the data window size. */
export function scrollMetrics(
  bounds: Range,
  range: Range,
  length: number,
  reverse = false,
) {
  const [min, max] = ordered(bounds);
  const [start, end] = ordered(range);
  const total = max - min;
  const span = end - start;
  const enabled = total > 0 && span > 0 && span < total * (1 - 1e-8);
  const fraction = enabled
    ? Math.max(0, Math.min(1, (start - min) / (total - span)))
    : 0;
  const size = enabled
    ? Math.min(length, Math.max(28, (length * span) / total))
    : length;
  return {
    enabled,
    size,
    travel: Math.max(0, length - size),
    position: (reverse ? 1 - fraction : fraction) * Math.max(0, length - size),
    fraction: enabled ? (reverse ? 1 - fraction : fraction) : 0,
    span,
    total,
  };
}
