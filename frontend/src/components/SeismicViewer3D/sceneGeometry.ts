import type { VS, Export3D } from "../../types";
import { PLOT_DASH } from "../plotStyle";
export type SliceData = {
  id: string;
  kind: "inline" | "crossline" | "time";
  position: number;
  requested_position: number;
  a: number[];
  b: number[];
  amplitude: (number | null)[][];
  native_shape: number[];
};
export type Intersection = {
  slice_id: string;
  kind: string;
  position: number;
  x: (number | null)[];
  y: (number | null)[];
  z: (number | null)[];
  horizon_time?: number[];
};
export type Mesh = {
  scalar: (number | null)[];
  twt_range: [number, number];
  x: number[];
  y: number[];
  z: (number | null)[];
  i: number[];
  j: number[];
  k: number[];
  native_shape: number[];
  preview_shape: number[];
};
export type SceneData = {
  slices: SliceData[];
  horizons: Record<string, { mesh?: Mesh; intersections?: Intersection[] }>;
  bounds: { x: number[]; y: number[]; z: number[] };
  vmin: number;
  vmax: number;
};
// Shared by horizons only; seismic colors and amplitude clipping are independent.
export const PETREL_COLORMAP = [
  [0, "#ff0000"], [1 / 7, "#ff8000"], [2 / 7, "#ffff00"],
  [3 / 7, "#00c040"], [4 / 7, "#00ffff"], [5 / 7, "#0000ff"],
  [6 / 7, "#8000c0"], [1, "#ff00ff"],
];
// scatter3d supports a reduced marker set (no triangle); keep 3D-specific symbols here.
const symbols: Record<string, string> = {
  circle: "circle",
  square: "square",
  diamond: "diamond",
  triangle: "diamond",
  cross: "x",
  plus: "cross",
};
const safe = (name: string) =>
  name.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function line(
  x: any[],
  y: any[],
  z: any[],
  color: string,
  width: number,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "scatter3d",
    mode: "lines",
    x,
    y,
    z,
    line: { color, width },
    hoverinfo: "skip",
    showlegend: false,
    connectgaps: false,
    ...extra,
  };
}
export function buildTraces(
  data: SceneData,
  view: VS,
  maps: Record<string, any[]>,
  exportSettings?: Export3D,
) {
  const traces: any[] = [];
  const s = view.seismic;
  const colors = maps[s.colormap] || [
    // Fallback until the catalog arrives: the Pos / 0 / Neg reference ramp.
    [0, "#23238e"],
    [0.5, "#ffffff"],
    [1, "#8c0000"],
  ];
  const colorscale = s.reverse_colormap
    ? colors.map((c, i) => [c[0], colors[colors.length - 1 - i][1]])
    : colors;
  for (const plane of data.slices) {
    const state = view.slices[plane.kind].find((p) => p.id === plane.id);
    if (!state?.visible) continue;
    const x: number[][] = [],
      y: number[][] = [],
      z: (number | null)[][] = [];
    plane.b.forEach((b, r) => {
      x.push(
        plane.a.map((a) => (plane.kind === "crossline" ? plane.position : a)),
      );
      y.push(
        plane.a.map((a) =>
          plane.kind === "inline"
            ? plane.position
            : plane.kind === "crossline"
              ? a
              : b,
        ),
      );
      z.push(
        plane.a.map((_, c) =>
          plane.amplitude[r][c] === null
            ? null
            : plane.kind === "time"
              ? plane.position
              : b,
        ),
      );
    });
    const surfacecolor = plane.amplitude.map((row) =>
      row.map((v) => (v === null ? null : s.reverse_polarity ? -v : v)),
    );
    traces.push({
      type: "surface",
      x,
      y,
      z,
      surfacecolor,
      colorscale,
      cmin: data.vmin,
      cmax: data.vmax,
      showscale: false,
      opacity: state.opacity,
      connectgaps: false,
      name: `${plane.kind} ${plane.position}`,
      // The texture may be resampled, so hover coordinates are resolved back
      // to the original SEG-Y sample by the probe readout.
      meta: { probe: { kind: plane.kind, position: plane.position } },
      lighting: {
        ambient: 1,
        diffuse: 0,
        specular: 0,
        roughness: 1,
        fresnel: 0,
      },
      hovertemplate:
        "Inline: %{y}<br>Crossline: %{x}<br>TWT: %{z:.1f} ms<extra>" +
        plane.kind +
        " " +
        plane.position +
        "</extra>",
    });
    if (state.border.visible) {
      const a0 = plane.a[0],
        a1 = plane.a.at(-1)!,
        b0 = plane.b[0],
        b1 = plane.b.at(-1)!;
      const aa = [a0, a1, a1, a0, a0],
        bb = [b0, b0, b1, b1, b0];
      traces.push(
        line(
          aa.map((a) => (plane.kind === "crossline" ? plane.position : a)),
          aa.map((a, i) =>
            plane.kind === "inline"
              ? plane.position
              : plane.kind === "crossline"
                ? a
                : bb[i],
          ),
          bb.map((b) => (plane.kind === "time" ? plane.position : b)),
          state.border.color,
          (state.border.width * 4) / 3,
          { opacity: state.opacity, meta: { depthLayer: 1 } },
        ),
      );
    }
  }
  for (const h of view.horizons) {
    if (!h.visible) continue;
    const hd = data.horizons[h.id];
    if (!hd) continue;
    if (h.display_mode === "full_surface" && hd.mesh) {
      const mesh = hd.mesh;
      const [tmin, tmax] = mesh.twt_range;
      const twtColor = h.color_by !== "solid";
      // A constant-time horizon uses the middle color, with a nonzero scale.
      const padding = tmin === tmax ? Math.max(0.5, Math.abs(tmin) * 1e-6) : 0;
      traces.push({          type: "mesh3d",
          x: mesh.x,
          y: mesh.y,
          z: mesh.z,
          i: mesh.i,
          j: mesh.j,
          k: mesh.k,
          color: h.color,
          ...(twtColor ? {
            intensity: mesh.scalar,
            intensitymode: "vertex",
            colorscale: PETREL_COLORMAP,
            cauto: false,
            cmin: tmin - padding,
            cmax: tmax + padding,
          } : {}),
          opacity: h.opacity,
          name: h.name,
          flatshading: h.smooth_shading === false,
          // gl-mesh3d computes vertex normals when useFacetNormals is false.
          lighting: h.lighting === false
            ? { ambient: 1, diffuse: 0, specular: 0, fresnel: 0 }
            : {
                // Keep at least 80% of the colormap RGB in unlit areas;
                // gentle diffuse shading reveals relief without darkening the map.
                ambient: 0.8, diffuse: 0.2, specular: 0.05,
                roughness: 0.55, fresnel: 0,
              },
          // gl-mesh3d unprojects this position by inverse projection/view/model
          // every frame, so the light remains attached to the camera during orbit.
          lightposition: { x: 0, y: 0, z: -1 },
          showscale: false,
          showlegend: false,
          hovertemplate: `${safe(h.name)}<br>Inline: %{y}<br>Crossline: %{x}<br>TWT: %{z:.1f} ms<extra></extra>`,
        });
    }
    if (h.display_mode === "slice_intersections")
      for (const pts of hd.intersections || []) {
        if (
          !view.slices[pts.kind as keyof VS["slices"]].some(
            (s) => s.id === pts.slice_id && s.visible,
          )
        )
          continue;
        const points = pts.kind === "time";
        const showLine = !points && h.line.visible && h.line.style !== "none";
        const showMarker =
          points || (h.marker.visible && h.marker.shape !== "none");
        if (!showLine && !showMarker) continue;
        const base = {
          type: "scatter3d",
          x: pts.x,
          y: pts.y,
          z: pts.z,
          connectgaps: false,
          showlegend: false,
          name: h.name,
          opacity: h.opacity,
        };
        if (showLine && h.outline.enabled)
          traces.push({
            ...base,
            meta: { depthLayer: 1 },
            mode: "lines",
            line: {
              color: "#000",
              width: ((h.line.width + 2 * h.outline.width) * 4) / 3,
              dash: PLOT_DASH[h.line.style],
            },
            hoverinfo: "skip",
          });
        traces.push({
          ...base,
          meta: { depthLayer: 2 },
          mode:
            showLine && showMarker
              ? "lines+markers"
              : showLine
                ? "lines"
                : "markers",
          line: {
            color: h.color,
            width: (h.line.width * 4) / 3,
            dash: PLOT_DASH[h.line.style],
          },
          marker: {
            color: h.color,
            size: points && !h.marker.visible ? 1.5 : (h.marker.size * 4) / 3,
            symbol: points ? "circle" : symbols[h.marker.shape] || "circle",
            line: {
              color: "#000",
              width:
                h.outline.enabled && (!points || h.marker.visible)
                  ? (h.outline.width * 4) / 3
                  : 0,
            },
          },
          customdata: pts.horizon_time,
          hovertemplate: `${safe(h.name)}<br>Inline: %{y}<br>Crossline: %{x}<br>TWT: %{z:.1f} ms${points ? "<br>Horizon TWT: %{customdata:.1f} ms" : ""}<extra></extra>`,
        });
      }
  }
  if (exportSettings?.show_bounding_box ?? view.scene.show_bounding_box) {
    const { x, y, z } = data.bounds;
    const xx: (number | null)[] = [],
      yy: (number | null)[] = [],
      zz: (number | null)[] = [];
    for (const axis of [0, 1, 2])
      for (const a of [0, 1])
        for (const b of [0, 1]) {
          const v = [0, 0, 0],
            w = [0, 0, 0];
          v[(axis + 1) % 3] = w[(axis + 1) % 3] = a;
          v[(axis + 2) % 3] = w[(axis + 2) % 3] = b;
          w[axis] = 1;
          xx.push(x[v[0]], x[w[0]], null);
          yy.push(y[v[1]], y[w[1]], null);
          zz.push(z[v[2]], z[w[2]], null);
        }
    traces.push(line(xx, yy, zz, "#7f919a", 1));
  }
  return traces;
}
export function buildLayout(
  data: SceneData,
  view: VS,
  drag: "orbit" | "pan",
  settings?: Export3D,
) {
  const axes = settings?.show_axes ?? view.scene.show_axes,
    labels = settings?.show_axis_labels ?? view.scene.show_axis_labels;
  const family = settings?.font || "Arial, sans-serif";
  const fontSize = settings?.font_size
    ? (settings.font_size * 4) / 3
    : undefined;
  // A publication figure prints in pure black; the on-screen viewer keeps the
  // softer interface ink. Both titles and tick labels must be overridden
  // explicitly, because Plotly resolves scene text from the axis definition.
  const ink = settings ? "#000000" : "#425367";
  const axis = (title: string, range: number[]) => ({
    title: {
      text: labels ? title : "",
      font: { family, size: fontSize ?? 12, color: ink },
    },
    range,
    autorange: false,
    visible: axes,
    showbackground: false,
    showgrid: axes,
    gridcolor: "#e5ecef",
    zeroline: false,
    showline: axes,
    linecolor: "#c0cdd3",
    tickfont: { family, size: fontSize ?? 10, color: ink },
    ticks: axes ? "outside" : "",
  });
  return {
    autosize: true,
    margin: { l: 12, r: 12, t: 12, b: 12 },
    paper_bgcolor: settings?.background || view.scene.background,
    font: { family, size: fontSize ?? 12, color: ink },
    showlegend: false,
    scene: {
      xaxis: axis("Crossline", data.bounds.x),
      yaxis: axis("Inline", data.bounds.y),
      zaxis: axis("TWT (ms)", [data.bounds.z[1], data.bounds.z[0]]),
      aspectmode: "manual",
      aspectratio: {
        x: view.scene.aspect_ratio[0],
        y: view.scene.aspect_ratio[1],
        z: view.scene.aspect_ratio[2],
      },
      camera: structuredClone(view.scene.camera),
      dragmode: drag,
      bgcolor: settings?.background || view.scene.background,
    },
  };
}
