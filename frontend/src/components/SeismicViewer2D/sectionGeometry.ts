import { Section, VS } from "../../types";
import { PLOT_DASH, SYMBOLS_2D } from "../plotStyle";

/** Plotly traces for one 2D section: the amplitude raster plus horizon lines. */
export function buildTraces(section: Section, view: VS, colors: any[]): any[] {
  const s = view.seismic;

  const colorScale = s.reverse_colormap
    ? colors.map((c, i) => [c[0], colors[colors.length - 1 - i][1]])
    : colors;

  const z = s.reverse_polarity ? section.z.map((r) => r.map((v) => -v)) : section.z;

  const inline = view.view_type === "inline";

  const traces: any[] = [
    {
      type: "heatmap",
      x: section.x,
      y: section.time,
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
        `<br>TWT: %{y:.1f} ms` +
        `<extra></extra>`,
    },
  ];

  for (const h of view.horizons) {
    const pts = section.horizons[h.id] || [];

    if (!h.visible || !pts.length) continue;

    const line = h.line.visible && h.line.style !== "none";
    const marker = h.marker.visible && h.marker.shape !== "none";

    if (!line && !marker) continue;

    const base = {
      type: "scatter",
      x: pts.map((p) => p[0]),
      y: pts.map((p) => p[1]),
      showlegend: false,
      connectgaps: false,
    };

    if (line && h.outline.enabled) {
      traces.push({
        ...base,
        mode: "lines",
        line: {
          color: "#000",
          width: ((h.line.width + 2 * h.outline.width) * 4) / 3,
          dash: PLOT_DASH[h.line.style],
        },
        hoverinfo: "skip",
      });
    }

    traces.push({
      ...base,
      name: h.name,
      mode: line && marker ? "lines+markers" : line ? "lines" : "markers",
      line: {
        color: h.color,
        width: (h.line.width * 4) / 3,
        dash: PLOT_DASH[h.line.style],
      },
      marker: {
        color: h.color,
        size: (h.marker.size * 4) / 3,
        symbol: SYMBOLS_2D[h.marker.shape],
        line: {
          color: "#000",
          width: h.outline.enabled ? (h.outline.width * 4) / 3 : 0,
        },
      },
      hovertemplate:
        `${h.name.replaceAll("<", "&lt;")}` +
        `<br>${inline ? "Crossline" : "Inline"}: %{x}` +
        `<br>TWT: %{y:.1f} ms` +
        `<extra></extra>`,
    });
  }

  return traces;
}

/** Plotly layout for one 2D section, honouring ranges and the aspect lock. */
export function buildLayout(section: Section, view: VS, drag: "zoom" | "pan") {
  const xr =
    view.x_range || [section.x[0] - 0.5, section.x.at(-1)! + 0.5];

  const tr = view.time_range || [section.time[0], section.time.at(-1)!];

  const inline = view.view_type === "inline";

  return {
    autosize: true,
    margin: { l: 72, r: 28, t: 28, b: 60 },
    paper_bgcolor: "#fff",
    plot_bgcolor: "#fff",
    font: {
      family: "Inter, Arial, sans-serif",
      color: "#425367",
      size: 11,
    },
    dragmode: drag,
    xaxis: {
      title: { text: inline ? "Crossline" : "Inline", standoff: 18 },
      constrain: "domain",
      range: [...xr],
      autorange: false,
      showgrid: false,
      zeroline: false,
      linecolor: "#bcc8cf",
      ticks: "outside",
    },
    yaxis: {
      constrain: "domain",
      scaleanchor: view.aspect_ratio_2d ? "x" : false,
      scaleratio: view.aspect_ratio_2d
        ? (view.aspect_ratio_2d[1] / view.aspect_ratio_2d[0]) *
          Math.abs((xr[1] - xr[0]) / (tr[1] - tr[0]))
        : 1,
      title: { text: "TWT (ms)", standoff: 16 },
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
