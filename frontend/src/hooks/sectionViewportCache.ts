import type { Section } from "../types";
import { coversViewport } from "../components/loadedRaster";

export type SectionWindow = {
  key: string;
  x: readonly number[];
  time: readonly number[];
  width: number;
  height: number;
  interpolate: boolean;
  overlays: boolean;
};

export type CachedSectionWindow = { key: string; data: Section };

/** The overview is shared navigation context, never eligible as detailed data. */
export function sectionWindowCovers(entry: CachedSectionWindow, request: SectionWindow) {
  return entry.key === request.key || entry.data.has_seismic === false ||
    coversViewport(entry.data, request.x, request.time, request.width, request.height,
      request.interpolate, request.overlays);
}

/** Only identical interpolated grids can stand in for the requested final grid.
 * Native cells remain exact within coverage at any zoom; waveform paths still
 * require identical viewport geometry.
 */
export function sectionWindowIsFinal(entry: CachedSectionWindow, request: SectionWindow) {
  return entry.key === request.key || entry.data.has_seismic === false ||
    (!request.interpolate && sectionWindowCovers(entry, request));
}

/** Estimate retained JS array storage, including waveform and horizon geometry. */
export function sectionWindowBytes(data: Section): number {
  const seen = new Set<object>();
  const bytes = (value: unknown): number => {
    if (value === null || typeof value !== "object" || seen.has(value)) return 0;
    seen.add(value);
    if (Array.isArray(value)) {
      let size = 24 + value.length * 8;
      for (const item of value) if (item !== null && typeof item === "object") size += bytes(item);
      return size;
    }
    return Object.values(value).reduce<number>((sum, item) => sum + bytes(item), 0);
  };
  let size = 0;
  for (const [name, value] of Object.entries(data)) if (name !== "overview") size += bytes(value);
  return size;
}

/** A bounded LRU for one scientific section. Its owner clears it on source changes. */
export class SectionViewportCache {
  private entries: (CachedSectionWindow & { bytes: number })[] = [];
  private bytes = 0;

  constructor(private maxBytes = 24 * 1024 * 1024, private maxEntries = 3) {}

  clear() {
    this.entries = [];
    this.bytes = 0;
  }

  find(request: SectionWindow): CachedSectionWindow | null {
    // Exact geometry wins, particularly when trace overlays depend on the viewport.
    // Nonidentical interpolated coverage is an immediate preview only; the
    // caller must still request amplitudes at the current grid's pixel centres.
    let index = this.entries.findIndex(entry => entry.key === request.key);
    if (index < 0) {
      for (let i = this.entries.length - 1; i >= 0; i--) {
        if (sectionWindowCovers(this.entries[i], request)) { index = i; break; }
      }
    }
    if (index < 0) return null;
    const [entry] = this.entries.splice(index, 1);
    this.entries.push(entry);
    return entry;
  }

  remember(key: string, data: Section): CachedSectionWindow {
    const previous = this.entries.findIndex(entry => entry.key === key);
    if (previous >= 0) this.bytes -= this.entries.splice(previous, 1)[0].bytes;
    const entry = { key, data, bytes: sectionWindowBytes(data) };
    // Oversized native windows may be displayed, but never retained as extra history.
    if (entry.bytes > this.maxBytes || this.maxEntries < 1) return entry;
    this.entries.push(entry);
    this.bytes += entry.bytes;
    while (this.entries.length > this.maxEntries || this.bytes > this.maxBytes)
      this.bytes -= this.entries.shift()!.bytes;
    return entry;
  }
}
