type Margin = { l: number; r: number; t: number; b: number };

/** Fit the drawing box without linking axis scales or changing selected ranges. */
export function plotAspectLayout(width: number, height: number, margin: Margin, ratio: number | null) {
  const availableWidth = Math.max(1, width - margin.l - margin.r);
  const availableHeight = Math.max(1, height - margin.t - margin.b);
  const fixed = ratio !== null && Number.isFinite(ratio) && ratio > 0;
  const xSpan = fixed ? Math.min(1, availableHeight * ratio / availableWidth) : 1;
  const ySpan = fixed ? Math.min(1, availableWidth / ratio / availableHeight) : 1;
  return {
    width, height,
    "xaxis.domain": [(1 - xSpan) / 2, (1 + xSpan) / 2],
    "yaxis.domain": [(1 - ySpan) / 2, (1 + ySpan) / 2],
    "xaxis.scaleanchor": false,
    "yaxis.scaleanchor": false,
  };
}
