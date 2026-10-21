import type { VS, Export3D, Section } from "../../types";
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
  a_edges?: number[];
  b_edges?: number[];
  trace_overlay?: Section["trace_overlay"];
  source_a_range?: number[];
  source_b_range?: number[];
  interpolation?: "sinc8" | "linear" | "native";
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
  amplitude?: (number | null)[];
  amplitude_faces?: { i: number[]; j: number[]; k: number[] };
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
export const PETREL_COLORMAP: [number, string][] = [
  [0, "#ff0000"], [1 / 7, "#ff8000"], [2 / 7, "#ffff00"],
  [3 / 7, "#00c040"], [4 / 7, "#00ffff"], [5 / 7, "#0000ff"],
  [6 / 7, "#8000c0"], [1, "#ff00ff"],
];
// scatter3d supports a reduced marker set (no triangle); keep 3D-specific symbols here.
const symbols: Record<string, string> = {
  circle: "circle",
  "circle-open": "circle",
  square: "square",
  diamond: "diamond",
  triangle: "diamond",
  cross: "x",
  plus: "cross",
};
const safe = (name: string) =>
  name.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
// Plotly otherwise matches actors by array index. Inserting a Wiggle/VA actor
// can then give a seismic mesh a horizon's persistent GPU colormap texture.
// Plotly uses UIDs in CSS selectors too. Hex-encode the identity without
// discarding punctuation/Unicode that could distinguish two source IDs.
const actorUid = (...parts: string[]) => "seis-" +
  Array.from(new TextEncoder().encode(JSON.stringify(parts)), byte => byte.toString(16).padStart(2, "0")).join("");
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

/** All slice geometry uses the same Trace/TWT-to-world transform. */
export function planePoint(plane: Pick<SliceData, "kind" | "position">, a: number, b: number) {
  return [plane.kind === "crossline" ? plane.position : a,
    plane.kind === "inline" ? plane.position : plane.kind === "crossline" ? a : b,
    plane.kind === "time" ? plane.position : b];
}

function rgb(color: string): number[] {
  if (color.startsWith("#")) {
    const hex = color.length === 4 ? color.slice(1).split("").map(c => c + c).join("") : color.slice(1);
    return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
  }
  return (color.match(/[\d.]+/g) || ["0", "0", "0"]).slice(0, 3).map(Number);
}

/** Colormap mapping follows amplitude interpolation/clipping. Every rendered
 * sample cell has constant face color, so WebGL never smooths an RGB texture. */
function sliceCells(plane: SliceData, colorscale: any[], data: SceneData, view: VS) {
  const colors = colorscale.map(([value, color]) => [value, rgb(color)]);
  const palette = Array.from({ length: 256 }, (_, index) => {
    const value = index / 255;
    let next = colors.findIndex(([at]) => at >= value);
    if (next < 1) next = next === 0 ? 1 : colors.length - 1;
    const [lo, a] = colors[next - 1], [hi, b] = colors[next];
    const fraction = hi === lo ? 0 : (value - lo) / (hi - lo);
    return `rgb(${a.map((v: number, i: number) => Math.round(v + fraction * (b[i] - v))).join(",")})`;
  });
  const x: number[] = [], y: number[] = [], z: number[] = [],
    i: number[] = [], j: number[] = [], k: number[] = [], facecolor: string[] = [];
  const width = plane.a_edges!.length;
  for (const b of plane.b_edges!) for (const a of plane.a_edges!) {
    const point = planePoint(plane, a, b);
    x.push(point[0]); y.push(point[1]); z.push(point[2]);
  }
  plane.amplitude.forEach((row, r) => row.forEach((sample, c) => {
    if (sample === null || !Number.isFinite(sample)) return;
    const value = view.seismic.reverse_polarity ? -sample : sample;
    const index = Math.max(0, Math.min(255, Math.floor(256 * (value - data.vmin) / (data.vmax - data.vmin))));
    const a = r * width + c, b = a + 1, d = a + width, e = d + 1;
    i.push(a, a); j.push(b, e); k.push(e, d);
    facecolor.push(palette[index], palette[index]);
  }));
  return { type: "mesh3d", x, y, z, i, j, k, facecolor, flatshading: true };
}

/** Positive lobes are time-directed strips. Triangulating each strip keeps
 * concave lobes and their exact zero-crossing boundaries inside the fill. */
export function variableAreaMesh(plane: SliceData) {
  const path = plane.trace_overlay?.variable_area;
  const x: number[] = [], y: number[] = [], z: number[] = [],
    i: number[] = [], j: number[] = [], k: number[] = [];
  let polygon: [number, number][] = [];
  function append() {
    if (polygon.length < 4) { polygon = []; return; }
    const baseline = polygon[0][0];
    const boundary = polygon.slice(0, -1);
    for (let n = 1; n < boundary.length; n++) {
      const [a, at] = boundary[n - 1], [b, bt] = boundary[n];
      if (bt <= at) continue;
      const first = x.length;
      for (const [horizontal, time] of [[baseline, at], [a, at], [b, bt], [baseline, bt]]) {
        const left = plane.a_edges?.[0] ?? plane.a[0], right = plane.a_edges?.at(-1) ?? plane.a.at(-1)!;
        const point = planePoint(plane, Math.max(left, Math.min(right, horizontal)), time);
        x.push(point[0]); y.push(point[1]); z.push(point[2]);
      }
      i.push(first, first); j.push(first + 1, first + 2); k.push(first + 2, first + 3);
    }
    polygon = [];
  }
  path?.x.forEach((value, n) => {
    const time = path.time[n];
    if (value === null || time === null) append();
    else polygon.push([value, time]);
  });
  append();
  return { type: "mesh3d", x, y, z, i, j, k, flatshading: true };
}

/** Clip strokes at the finite seismic plane without moving trace baselines. */
export function wiggleCoordinates(plane: SliceData) {
  const path = plane.trace_overlay!.wiggle;
  const left = plane.a_edges?.[0] ?? plane.a[0], right = plane.a_edges?.at(-1) ?? plane.a.at(-1)!;
  const top = plane.b_edges?.[0] ?? plane.b[0], bottom = plane.b_edges?.at(-1) ?? plane.b.at(-1)!;
  const points: (number | null)[][] = [];
  let previous: [number, number] | null = null;
  let last: [number, number] | null = null;
  for (let n = 0; n < path.x.length; n++) {
    const a = path.x[n], b = path.time[n];
    if (a === null || b === null) { previous = last = null; continue; }
    const current: [number, number] = [a, b];
    if (previous) {
      let low = 0, high = 1;
      for (const [axis, lower, upper] of [[0, left, right], [1, top, bottom]]) {
        const delta = current[axis] - previous[axis];
        if (!delta) { if (current[axis] < lower || current[axis] > upper) high = -1; }
        else {
          const p = (lower - previous[axis]) / delta, q = (upper - previous[axis]) / delta;
          low = Math.max(low, Math.min(p, q)); high = Math.min(high, Math.max(p, q));
        }
      }
      if (low <= high) {
        const start: [number, number] = [previous[0] + low * (a - previous[0]), previous[1] + low * (b - previous[1])];
        const end: [number, number] = [previous[0] + high * (a - previous[0]), previous[1] + high * (b - previous[1])];
        if (!last || last[0] !== start[0] || last[1] !== start[1]) {
          if (points.length) points.push([null, null, null]);
          points.push(planePoint(plane, ...start));
        }
        points.push(planePoint(plane, ...end)); last = end;
      } else last = null;
    }
    previous = current;
  }
  return points;
}

export function buildTraces(
  data: SceneData,
  view: VS,
  maps: Record<string, any[]>,
  exportSettings?: Export3D,
  cacheExportActors = false,
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
      ...(plane.a_edges && plane.b_edges ? sliceCells(plane, colorscale, data, view)
        : { type: "surface", x, y, z, surfacecolor }),
      uid: actorUid("slice", plane.kind, plane.id, "background"),
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
        "Inline: %{y}<br>Crossline: %{x}<br>Time: %{z:.1f} ms<extra>" +
        plane.kind +
        " " +
        plane.position +
        "</extra>",
    });
    if (plane.kind !== "time" && plane.trace_overlay) {
      if (s.variable_area && plane.trace_overlay.variable_area.x.length)
        traces.push({ ...variableAreaMesh(plane), color: s.variable_area_color,
          uid: actorUid("slice", plane.kind, plane.id, "variable-area"),
          lighting: { ambient: 1, diffuse: 0, specular: 0, fresnel: 0 },
          opacity: state.opacity, showlegend: false, hoverinfo: "skip", meta: { depthLayer: 1 } });
      if (s.wiggle && plane.trace_overlay.wiggle.x.length) {
        const points = wiggleCoordinates(plane);
        traces.push(line(points.map(p => p[0]), points.map(p => p[1]), points.map(p => p[2]),
          "#000000", 0.8, { uid: actorUid("slice", plane.kind, plane.id, "wiggle"),
            opacity: state.opacity, meta: { depthLayer: 2 } }));
      }
    }
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
          { uid: actorUid("slice", plane.kind, plane.id, "border"),
            opacity: state.opacity, meta: { depthLayer: s.wiggle || s.variable_area ? 4 : 1 } },
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
      const amplitudeColor = h.color_by === "amplitude";
      if (amplitudeColor && (!mesh.amplitude || !mesh.amplitude_faces?.i.length)) continue;
      const twtColor = h.color_by !== "solid" && !amplitudeColor;
      const intensity = amplitudeColor
        ? mesh.amplitude!.map(v => v === null ? null : s.reverse_polarity ? -v : v)
        : mesh.scalar;
      const faces = amplitudeColor ? mesh.amplitude_faces! : mesh;
      // A constant-time horizon uses the middle color, with a nonzero scale.
      const padding = tmin === tmax ? Math.max(0.5, Math.abs(tmin) * 1e-6) : 0;
      traces.push({          type: "mesh3d",
          // gl-mesh3d retains its texture when changing from intensity to
          // solid color, so those two coloring modes need separate actors.
          uid: actorUid("horizon", h.id, "surface", amplitudeColor ? "amplitude" : twtColor ? "twt" : "solid"),
          x: mesh.x,
          y: mesh.y,
          z: mesh.z,
          i: faces.i,
          j: faces.j,
          k: faces.k,
          color: h.color,
          ...(twtColor ? {
            intensity: mesh.scalar,
            intensitymode: "vertex",
            colorscale: PETREL_COLORMAP,
            cauto: false,
            cmin: tmin - padding,
            cmax: tmax + padding,
          } : {}),
          ...(amplitudeColor ? {
            intensity, intensitymode: "vertex", colorscale,
            cauto: false, cmin: data.vmin, cmax: data.vmax,
            customdata: intensity,
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
          // every frame. surfaceLighting keeps its vectors in world space and
          // corrects mirrored Time normals, keeping this camera light on the front.
          lightposition: { x: 0, y: 0, z: -1 },
          showscale: false,
          showlegend: false,
          hovertemplate: `${safe(h.name)}<br>Inline: %{y}<br>Crossline: %{x}<br>Time: %{z:.1f} ms` +
            (amplitudeColor ? "<br>振幅: %{customdata:.4g}" : "") + "<extra></extra>",
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
        const hollow = h.marker.shape === "circle-open" && (!points || h.marker.visible);
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
            uid: actorUid("horizon", h.id, pts.kind, pts.slice_id, "outline"),
            meta: { depthLayer: s.wiggle || s.variable_area ? 3 : 1 },
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
          uid: actorUid("horizon", h.id, pts.kind, pts.slice_id, "foreground"),
          meta: { depthLayer: s.wiggle || s.variable_area ? 4 : 2 },
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
            color: hollow ? "#fff" : h.color,
            size: points && !h.marker.visible ? 1.5 : (h.marker.size * 4) / 3,
            symbol: points && !hollow ? "circle" : symbols[h.marker.shape] || "circle",
            line: {
              color: hollow ? h.color : "#000",
              width:
                hollow
                  ? Math.max(1, h.outline.enabled ? (h.outline.width * 4) / 3 : 0)
                  : h.outline.enabled && (!points || h.marker.visible)
                  ? (h.outline.width * 4) / 3
                  : 0,
            },
          },
          customdata: pts.horizon_time,
          hovertemplate: `${safe(h.name)}<br>Inline: %{y}<br>Crossline: %{x}<br>Time: %{z:.1f} ms${points ? "<br>Horizon Time: %{customdata:.1f} ms" : ""}<extra></extra>`,
        });
      }
  }
  if (cacheExportActors || (exportSettings?.show_bounding_box ?? view.scene.show_bounding_box)) {
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
    traces.push(line(xx, yy, zz, "#7f919a", 1, { uid: actorUid("scene", "bounding-box"), meta: { exportRole: "boundingBox",
      interactiveVisible: exportSettings?.show_bounding_box ?? view.scene.show_bounding_box } }));
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
  const family = settings?.font || "DM Sans, 'PingFang SC', Arial, sans-serif";
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
    linecolor: settings ? "#000000" : "#c0cdd3",
    linewidth: settings ? 0.8 * 4 / 3 : 1,
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
      zaxis: axis("Time (ms)", [data.bounds.z[1], data.bounds.z[0]]),
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
