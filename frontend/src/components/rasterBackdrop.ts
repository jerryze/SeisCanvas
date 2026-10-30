type PlotElement = Element & {
  _fullLayout?: { plot_bgcolor?: string };
  on?: (event: string, listener: () => void) => unknown;
  removeListener?: (event: string, listener: () => void) => unknown;
};

const SVG = "http://www.w3.org/2000/svg";
const backdrops = new WeakMap<PlotElement, Map<Element, SVGRectElement>>();
const installations = new WeakMap<PlotElement, { bind: () => void; cleanup: () => void }>();

/** Plotly may crop a heatmap bitmap even when its cached data covers the survey.
 * Cover only that actual bitmap, including its transparent null cells. The
 * full navigation image stays visible everywhere else during native dragging.
 * Sharing the image's parent also shares Plotly's live translate/scale exactly.
 */
export function syncRasterBackdrop(el: PlotElement): void {
  const images = new Set(el.querySelectorAll(".heatmaplayer .hm image"));
  let owned = backdrops.get(el);
  if (!owned) { owned = new Map(); backdrops.set(el, owned); }
  for (const [image, rect] of owned) {
    if (!images.has(image)) { rect.remove(); owned.delete(image); }
  }
  for (const image of images) {
    const x = image.getAttribute("x") ?? "0", y = image.getAttribute("y") ?? "0";
    const width = image.getAttribute("width"), height = image.getAttribute("height");
    if (![x, y, width, height].every(value => value !== null && Number.isFinite(Number(value))) ||
      Number(width) <= 0 || Number(height) <= 0 || !image.parentNode) {
      owned.get(image)?.remove(); owned.delete(image);
      continue;
    }
    let rect = owned.get(image);
    if (!rect) {
      rect = el.ownerDocument.createElementNS(SVG, "rect");
      rect.setAttribute("data-seiscanvas-raster-backdrop", "true");
      rect.setAttribute("pointer-events", "none");
      rect.setAttribute("aria-hidden", "true");
      rect.setAttribute("stroke", "none");
      rect.setAttribute("fill-opacity", "1");
      owned.set(image, rect);
    }
    rect.setAttribute("x", x); rect.setAttribute("y", y);
    rect.setAttribute("width", width!); rect.setAttribute("height", height!);
    rect.setAttribute("fill", el._fullLayout?.plot_bgcolor || "#fff");
    // Plotly currently transforms the containing plot group, but retain any
    // image-local transform too without copying its opacity or pixel content.
    for (const attribute of ["transform", "clip-path"]) {
      const value = image.getAttribute(attribute);
      if (value === null) rect.removeAttribute(attribute);
      else rect.setAttribute(attribute, value);
    }
    if (rect.parentNode !== image.parentNode || rect.nextSibling !== image)
      image.parentNode.insertBefore(rect, image);
  }
}

/** Idempotent per graph; touches only our listener and our own SVG rectangles.
 * DOM-only synchronization cannot cause a recursive Plotly redraw/event loop.
 */
export function installRasterBackdrop(el: PlotElement): () => void {
  let installation = installations.get(el);
  if (!installation) {
    let bound = false, disposed = false;
    const sync = () => syncRasterBackdrop(el);
    installation = {
      bind() {
        if (!bound && el.on) { el.on("plotly_afterplot", sync); bound = true; }
      },
      cleanup() {
        if (disposed) return;
        disposed = true;
        if (bound) el.removeListener?.("plotly_afterplot", sync);
        for (const rect of backdrops.get(el)?.values() ?? []) rect.remove();
        backdrops.delete(el);
        installations.delete(el);
      },
    };
    installations.set(el, installation);
  }
  installation.bind();
  syncRasterBackdrop(el);
  return installation.cleanup;
}
