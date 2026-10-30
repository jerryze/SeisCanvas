import type { Section, SectionOverview, SS, VS } from "../../types";

export const OVERVIEW_IMAGE_WIDTH = 512;
export const OVERVIEW_IMAGE_HEIGHT = 256;
export const OVERVIEW_IMAGE_PIXEL_LIMIT = OVERVIEW_IMAGE_WIDTH * OVERVIEW_IMAGE_HEIGHT;

type Tile = Pick<SectionOverview, "x_edges" | "time_edges" | "z">;
type Coloring = Pick<SS, "reverse_colormap" | "reverse_polarity">;
type Stop = { position: number; rgb: number[] };

export type OverviewImage = {
  source: string;
  xref: "x";
  yref: "y";
  x: number;
  y: number;
  xanchor: "left";
  yanchor: "top";
  sizex: number;
  sizey: number;
  sizing: "stretch";
  layer: "below";
  opacity: 1;
};

function palette(colors: any[], reverse: boolean): Stop[] {
  const stops: Stop[] = [];
  for (let index = 0; index < colors.length; index++) {
    const position = Number(colors[index]?.[0]);
    const value = colors[reverse ? colors.length - 1 - index : index]?.[1];
    if (!Number.isFinite(position) || position < 0 || position > 1 ||
      (index > 0 && position < stops[index - 1].position) || typeof value !== "string" ||
      !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) return [];
    const hex = value.length === 4 ? value.slice(1).split("").map(channel => channel + channel).join("") : value.slice(1);
    stops.push({ position, rgb: [0, 2, 4].map(start => parseInt(hex.slice(start, start + 2), 16)) });
  }
  return stops;
}

/** Find a physical cell without interpolating its stored scalar. */
function cell(edges: number[], coordinate: number) {
  let low = 0, high = edges.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (edges[middle] <= coordinate) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, Math.min(edges.length - 2, low - 1));
}

function paint(value: number, stops: Stop[], output: Uint8ClampedArray, offset: number) {
  // Match Plotly's bundled d3.scale.linear: bisect interior domain stops,
  // clamp within that interval, then interpolate each numeric RGB channel.
  let low = 1, high = stops.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (stops[middle].position <= value) low = middle + 1;
    else high = middle;
  }
  const a = stops[Math.max(0, low - 1)], b = stops[Math.min(stops.length - 1, low)];
  const difference = b.position - a.position;
  const fraction = Math.max(0, Math.min(1, (value - a.position) / (difference || 1 / difference)));
  for (let channel = 0; channel < 3; channel++)
    output[offset + channel] = Math.round(a.rgb[channel] * (1 - fraction) + b.rgb[channel] * fraction);
  output[offset + 3] = 255;
}

/** Navigation-only RGBA: physical cell lookup, then the heatmap's RGB ramp.
 * No amplitude interpolation, averaging, clipping back into data or gap fill.
 * Row zero is the smallest time, matching the section's reversed time axis.
 */
export function overviewTileRGBA(tile: Tile, width: number, height: number,
  colors: any[], vmin: number, vmax: number, seismic: Coloring): Uint8ClampedArray {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
    width > OVERVIEW_IMAGE_WIDTH || height > OVERVIEW_IMAGE_HEIGHT)
    throw new RangeError("Navigation image dimensions exceed their bounded raster.");
  const output = new Uint8ClampedArray(width * height * 4);
  const stops = palette(colors, seismic.reverse_colormap);
  if (!stops.length || !Number.isFinite(vmin) || !Number.isFinite(vmax) || vmax <= vmin ||
    tile.x_edges.length < 2 || tile.time_edges.length < 2) return output;
  // Plotly maps its color stops into amplitude units before calculating each
  // interval's fraction. Normalizing the value first changes rounding near
  // half-channel boundaries, even with an otherwise identical RGB ramp.
  for (const stop of stops) stop.position = vmin + stop.position * (vmax - vmin);
  const [left, right] = [tile.x_edges[0], tile.x_edges.at(-1)!];
  const [top, bottom] = [tile.time_edges[0], tile.time_edges.at(-1)!];
  const columns = Array.from({ length: width }, (_, column) =>
    cell(tile.x_edges, left + (column + .5) * (right - left) / width));
  for (let row = 0; row < height; row++) {
    const samples = tile.z[cell(tile.time_edges, top + (row + .5) * (bottom - top) / height)];
    for (let column = 0; column < width; column++) {
      const sample = samples?.[columns[column]];
      if (sample === null || sample === undefined || !Number.isFinite(sample)) continue;
      const value = seismic.reverse_polarity ? -sample : sample;
      paint(value, stops, output, (row * width + column) * 4);
    }
  }
  return output;
}

const imageCache = new WeakMap<SectionOverview, { colors: any[]; style: string; images: OverviewImage[] }>();

/** Full SVG layout images survive Plotly's native drag transforms offscreen.
 * One bounded PNG covers the complete source; the precise heatmap's own opaque
 * background masks it wherever that bitmap is actually drawn, including gaps.
 * Source arrays are immutable. All detailed windows share this overview's last
 * color/style image, so viewport changes neither encode nor retain more PNGs.
 */
export function buildOverviewImages(section: Section, view: Pick<VS, "seismic">, colors: any[]): OverviewImage[] {
  const overview = section.overview;
  if (!overview || section.has_seismic === false || !colors.length ||
    section.vmin === null || section.vmax === null || !Number.isFinite(section.vmin) ||
    !Number.isFinite(section.vmax) || section.vmax <= section.vmin || typeof document === "undefined") return [];
  const seismic = view.seismic;
  const style = JSON.stringify([section.vmin, section.vmax, seismic.reverse_colormap, seismic.reverse_polarity]);
  const cached = imageCache.get(overview);
  if (cached?.colors === colors && cached.style === style) return cached.images;
  if (!palette(colors, seismic.reverse_colormap).length) return [];
  const [left, right, top, bottom] = overview.raster_extent;
  if (![left, right, top, bottom].every(Number.isFinite) || right <= left || bottom <= top) return [];
  const canvas = document.createElement("canvas");
  canvas.width = OVERVIEW_IMAGE_WIDTH; canvas.height = OVERVIEW_IMAGE_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) return [];
  const pixels = context.createImageData(canvas.width, canvas.height);
  pixels.data.set(overviewTileRGBA(overview, canvas.width, canvas.height, colors, section.vmin, section.vmax, seismic));
  context.putImageData(pixels, 0, 0);
  const images: OverviewImage[] = [{ source: canvas.toDataURL("image/png"), xref: "x", yref: "y", x: left, y: top,
    xanchor: "left", yanchor: "top", sizex: right - left, sizey: bottom - top,
    sizing: "stretch", layer: "below", opacity: 1 }];
  imageCache.set(overview, { colors, style, images });
  return images;
}
