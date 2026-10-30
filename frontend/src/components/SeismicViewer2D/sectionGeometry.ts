import { Section, VS } from "../../types";
import { PLOT_DASH, SYMBOLS_2D } from "../plotStyle";
import { horizonCurve, HorizonCurveViewport } from "./horizonCurve";
import { plotAspectLayout } from "../plotAspect";

export const SECTION_MARGIN = { l: 72, r: 28, t: 28, b: 60 };

/** Layer order: fine raster, variable area, wiggle, then horizon lines.
 * Navigation lives in layout.images so Plotly cannot discard off-screen tiles.
 */
export function buildTraces(section: Section, view: VS, colors: any[], horizontalLabel?: string,
  horizonViewport?: HorizonCurveViewport): any[] {
  const s = view.seismic;

  const colorScale = s.reverse_colormap
    ? colors.map((c, i) => [c[0], colors[colors.length - 1 - i][1]])
    : colors;

  const z = s.reverse_polarity
    ? section.z.map((r) => r.map((v) => v === null ? null : -v)) : section.z;

  const inline = view.view_type === "inline";

  const hasSeismic = section.has_seismic !== false && section.z.length > 0;
  const traces: any[] = hasSeismic ? [
    {
      type: "heatmap",
      x: section.x_edges ?? section.x,
      y: section.time_edges ?? section.time,
      z,
      colorscale: colorScale.length ? colorScale : "RdBu",
      zmin: section.vmin,
      zmax: section.vmax,
      showscale: false,
      zsmooth: false,
      // Only real coordinates here: the displayed amplitude may be an
      // interpolated render pixel, so the readout probes the SEG-Y.
      hovertemplate:
        `Inline: ${inline ? view.section_number : "%{x}"}` +
        `<br>Crossline: ${inline ? "%{x}" : view.section_number}` +
        `<br>Time: %{y:.1f} ms` +
        `<extra></extra>`,
    },
  ] : [];

  // Overlay coordinates are computed from the original samples by the backend;
  // reuse them as supplied so raster interpolation never shifts a trace or
  // applies clipping/polarity/gain a second time.
  const overlay = section.trace_overlay;
  if (hasSeismic && s.variable_area && overlay?.variable_area.x.length) {
    traces.push({
      type: "scatter",
      mode: "lines",
      x: overlay.variable_area.x,
      y: overlay.variable_area.time,
      fill: "toself",
      fillcolor: s.variable_area_color,
      line: { color: s.variable_area_color, width: 0, simplify: false },
      showlegend: false,
      hoverinfo: "skip",
      connectgaps: false,
      cliponaxis: true,
    });
  }
  if (hasSeismic && s.wiggle && overlay?.wiggle.x.length) {
    traces.push({
      type: "scatter",
      mode: "lines",
      x: overlay.wiggle.x,
      y: overlay.wiggle.time,
      // 0.8 CSS px equals the export renderer's 0.6 pt stroke at 96 dpi.
      line: { color: "#000000", width: 0.8, simplify: false },
      showlegend: false,
      hoverinfo: "skip",
      connectgaps: false,
      cliponaxis: true,
    });
  }

  for (const h of view.horizons) {
    const pts = section.horizons[h.id] || [];

    if (!h.visible || !pts.length) continue;

    const line = h.line.visible && h.line.style !== "none";
    const marker = h.marker.visible && h.marker.shape !== "none";

    if (!line && !marker) continue;

    const base = {
      type: "scatter",
      meta: { horizonId: h.id },
      x: pts.map((p) => p[0]),
      y: pts.map((p) => p[1]),
      showlegend: false,
      connectgaps: false,
    };
    // A response for a previous window/section must never supply SG geometry.
    const display = section.horizon_display;
    const sg = line && horizonViewport && view.horizon_sg && display?.algorithm === "sg"
      && display.window === (view.horizon_sg_window ?? 7)
      && display.view_type === view.view_type && display.section_number === view.section_number;
    // PCHIP works on display knots; original picks still own all interaction.
    const smooth = line && view.smooth_horizons && horizonViewport;
    const knots = sg ? (display.points[h.id] ?? pts) as number[][] : pts;
    const curve = smooth ? horizonCurve(knots, horizonViewport) : knots;
    const displayOnly = smooth || sg;
    const lineBase = { ...base, x: curve.map(p => p[0]), y: curve.map(p => p[1]) };

    if (line && h.outline.enabled) {
      traces.push({
        ...lineBase,
        mode: "lines",
        line: {
          color: "#000",
          width: ((h.line.width + 2 * h.outline.width) * 4) / 3,
          dash: PLOT_DASH[h.line.style],
          shape: "linear",
          simplify: false,
        },
        hoverinfo: "skip",
      });
    }

    if (displayOnly) {
      traces.push({
        ...lineBase,
        mode: "lines",
        line: { color: h.color, width: (h.line.width * 4) / 3,
          dash: PLOT_DASH[h.line.style], shape: "linear", simplify: false },
        hoverinfo: "skip",
      });
    }

    // The original points still own markers and hover/probe coordinates.
    // A zero-width raw line keeps Plotly's existing point hit testing intact.
    traces.push({
      ...base,
      name: h.name,
      mode: line && marker ? "lines+markers" : line ? "lines" : "markers",
      line: {
        color: h.color,
        width: displayOnly ? 0 : (h.line.width * 4) / 3,
        dash: PLOT_DASH[h.line.style],
        shape: "linear",
        simplify: false,
      },
      marker: {
        color: h.marker.shape === "circle-open" ? "#fff" : h.color,
        size: (h.marker.size * 4) / 3,
        symbol: SYMBOLS_2D[h.marker.shape],
        line: {
          color: h.marker.shape === "circle-open" ? h.color : "#000",
          width: h.marker.shape === "circle-open"
            ? Math.max(1, h.outline.enabled ? (h.outline.width * 4) / 3 : 0)
            : h.outline.enabled ? (h.outline.width * 4) / 3 : 0,
        },
      },
      hovertemplate:
        `${h.name.replaceAll("<", "&lt;")}` +
        `<br>${horizontalLabel || (inline ? "Crossline" : "Inline")}: %{x}` +
        `<br>Time: %{y:.1f} ms` +
        `<extra></extra>`,
    });
  }

  return traces;
}

/** Plotly layout for one 2D section, honouring ranges and the aspect lock. */
export function buildLayout(section: Section, view: VS, drag: "zoom" | "pan",
  size = { width: 700, height: 450 }) {
  const extent = section.raster_extent;
  const xr =
    view.x_range || (extent ? [extent[0], extent[1]] : [section.x[0] - 0.5, section.x.at(-1)! + 0.5]);

  const tr = view.time_range || section.window?.time_range
    || [section.time[0], section.time.at(-1)!];

  const inline = view.view_type === "inline";
  const frame = plotAspectLayout(size.width, size.height, SECTION_MARGIN,
    view.aspect_ratio_2d ? view.aspect_ratio_2d[0] / view.aspect_ratio_2d[1] : null);

  return {
    width: size.width, height: size.height,
    autosize: true,
    margin: SECTION_MARGIN,
    paper_bgcolor: "#fff",
    plot_bgcolor: "#fff",
    font: {
      family: "DM Sans, 'PingFang SC', Arial, sans-serif",
      color: "#425367",
      size: 11,
    },
    dragmode: drag,
    xaxis: {
      layer: "above traces",
      title: { text: inline ? "Crossline" : "Inline", standoff: 18 },
      domain: frame["xaxis.domain"],
      scaleanchor: false,
      range: [...xr],
      autorange: false,
      showgrid: false,
      zeroline: false,
      linecolor: "#bcc8cf",
      ticks: "outside",
    },
    yaxis: {
      layer: "above traces",
      domain: frame["yaxis.domain"],
      scaleanchor: false,
      title: { text: "Time (ms)", standoff: 16 },
      range: [Math.max(...tr), Math.min(...tr)],
      autorange: false,
      showgrid: false,
      zeroline: false,
      linecolor: "#bcc8cf",
      ticks: "outside",
    },
    hovermode: "closest",
  };
}
