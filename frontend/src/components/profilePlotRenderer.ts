type HorizonVisibility = { id: string; visible: boolean };
type Trace = { visible?: boolean | string; meta?: { horizonId?: string }; [key: string]: any };
type PlotAPI = {
  react: (el: any, traces: Trace[], layout: any, config: any) => Promise<any>;
  restyle: (el: any, update: any, indices: number[]) => Promise<any>;
  relayout: (el: any, update: any) => Promise<any>;
  purge: (el: any) => void;
};

/** Stable A–B traces: visibility never replaces the background or layout.
 * Serialize Plotly calls so rapid toggles cannot race an in-flight render.
 */
export function createProfilePlotRenderer(plotly: PlotAPI, el: any, onError: (error: string) => void) {
  let queue = Promise.resolve();
  let disposed = false;
  let revision = 0;
  let traces: Trace[] | null = null;
  let visibility = new Map<string, boolean>();
  let size: { width: number; height: number } | null = null;

  function enqueue(action: () => Promise<void>) {
    queue = queue.then(async () => { if (!disposed) await action(); })
      .catch(error => { if (!disposed) onError(String(error)); });
    return queue;
  }
  function desired(trace: Trace) {
    return trace.meta?.horizonId ? visibility.get(trace.meta.horizonId) ?? false : trace.visible ?? true;
  }
  async function applyVisibility() {
    if (!traces || disposed) return;
    const indices: number[] = [], values: boolean[] = [];
    traces.forEach((trace, i) => {
      if (!trace.meta?.horizonId) return;
      const visible = desired(trace) as boolean;
      if ((trace.visible ?? true) !== visible) { indices.push(i); values.push(visible); }
    });
    if (!indices.length) return;
    await plotly.restyle(el, { visible: values }, indices);
    if (!disposed) indices.forEach((i, n) => { traces![i].visible = values[n]; });
  }
  return {
    visibility(horizons: HorizonVisibility[]) {
      visibility = new Map(horizons.map(h => [h.id, h.visible]));
      return enqueue(applyVisibility);
    },
    render(next: Trace[], layout: any, config: any, onRendered: () => void) {
      const token = ++revision;
      return enqueue(async () => {
        if (token !== revision) return;
        next.forEach(trace => { if (trace.meta?.horizonId) trace.visible = desired(trace); });
        await plotly.react(el, next, layout, config);
        if (disposed || token !== revision) return;
        traces = next;
        size = { width: el._fullLayout?.width ?? el.clientWidth, height: el._fullLayout?.height ?? el.clientHeight };
        await applyVisibility();
        if (!disposed && token === revision) onRendered();
      });
    },
    resize(width: number, height: number, onResized: () => void) {
      return enqueue(async () => {
        if (!traces || width <= 0 || height <= 0 || (size?.width === width && size.height === height)) return;
        await plotly.relayout(el, { width, height });
        size = { width, height };
        if (!disposed) onResized();
      });
    },
    viewport(update: Record<string, unknown>, onRendered: () => void) {
      return enqueue(async () => {
        if (!traces) return;
        await plotly.relayout(el, update);
        if (!disposed) onRendered();
      });
    },
    dispose() {
      if (disposed) return queue;
      disposed = true;
      revision++;
      queue = queue.then(() => { plotly.purge(el); traces = null; });
      return queue;
    },
  };
}
