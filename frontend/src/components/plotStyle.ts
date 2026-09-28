/** Plotly style mappings shared by the 2D section and 3D scene renderers. */

export const PLOT_DASH: Record<string, string> = {
  solid: "solid",
  dashed: "dash",
  dotted: "dot",
  dashdot: "dashdot",
};

/** 2D scatter supports the full marker set; scatter3d has no triangle. */
export const SYMBOLS_2D: Record<string, string> = {
  circle: "circle",
  square: "square",
  triangle: "triangle-up",
  diamond: "diamond",
  cross: "x",
  plus: "cross",
};
