import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText).toString('base64');
const react = moduleURL(`
  export function useRef(initial) {
    const h = globalThis.sectionPlotTest;
    const index = h.refIndex ?? 0;
    h.refIndex = index + 1;
    h.refs ??= [];
    return h.refs[index] ??= { current: index === 0 ? h.el : initial };
  }
  export function useEffect(effect) { globalThis.sectionPlotTest.effects.push(effect); }
  export function useState() { return [globalThis.sectionPlotTest.viewport ?? null,
    update => { globalThis.sectionPlotTest.viewport = update(globalThis.sectionPlotTest.viewport ?? null); }]; }
`);
const plotly = moduleURL(`
  export default {
    async react(el, traces) {
      el.data = traces;
      el._fullLayout = globalThis.sectionPlotTest.initialLayout;
    },
    Plots: { async resize(el) { el._fullLayout = globalThis.sectionPlotTest.resizedLayout; } },
    purge(el) { globalThis.sectionPlotTest.purged = el; },
  };
`);
const geometry = moduleURL(`
  export const buildTraces = (...args) => { globalThis.sectionPlotTest.sampling.push(args[4]); return []; };
  export const buildLayout = (section, view) => ({ xaxis: { range: view.x_range || [10, 20] },
    yaxis: { range: view.time_range || [200, 100], scaleanchor: false, scaleratio: 1 } });
`);
const display = moduleURL(await readFile(new URL('../src/components/SeismicViewer2D/sectionDisplay.ts', import.meta.url), 'utf8'));
const scrollFrame = moduleURL(`import Plotly from ${JSON.stringify(plotly)};
  export default function Frame() {};
  export const updatePlotData = (...args) => Plotly.react(...args);
  export const isScrollPreview = () => !!globalThis.sectionPlotTest.preview;
  export async function updatePlotLayout(el, update) { (globalThis.sectionPlotTest.layouts ??= []).push(update); }`);
const scrollMath = moduleURL(await readFile(new URL('../src/components/plotScrollMath.ts', import.meta.url), 'utf8'));
const source = (await readFile(new URL('../src/components/SeismicViewer2D/SectionPlot.tsx', import.meta.url), 'utf8'))
  .replace('"react"', JSON.stringify(react))
  .replace('"plotly.js-dist-min"', JSON.stringify(plotly))
  .replace('"../PlotScrollFrame"', JSON.stringify(scrollFrame))
  .replace('"../plotScrollMath"', JSON.stringify(scrollMath))
  .replace('"./sectionGeometry"', JSON.stringify(geometry))
  .replace('"./sectionDisplay"', JSON.stringify(display));
const { default: SectionPlot } = await import(moduleURL('const React = { createElement: (tag, props) => ({ tag, props }) };\n' + source));
const settled = () => new Promise(resolve => setImmediate(resolve));

test('2D renderer reports usable CSS width and height after rendering and resizing, and stops after unmount', async () => {
  const previousObserver = globalThis.ResizeObserver;
  const previousWindow = globalThis.window;
  const sizes = [];
  const errors = [];
  const h = globalThis.sectionPlotTest = {
    el: { clientWidth: 1400, listeners: {}, on(event, handler) { this.listeners[event] = handler; },
      removeAllListeners(event) { delete this.listeners[event]; } }, effects: [], sampling: [], patches: [],
    // Full container/device pixels intentionally differ from the usable CSS axes.
    initialLayout: { width: 1400, height: 900, xaxis: { _length: 801.4 }, yaxis: { _length: 500.6 } },
    resizedLayout: { width: 1600, height: 1000, xaxis: { _length: 901.2 }, yaxis: { _length: 601.8 } },
  };
  globalThis.window = { devicePixelRatio: 2 };
  globalThis.ResizeObserver = class {
    constructor(callback) { h.resize = callback; }
    observe(el) { h.observed = el; }
    disconnect() { h.disconnected = true; }
  };
  const dispose = [];
  try {
    SectionPlot({
      view: { view_type: 'inline', section_number: 350 }, section: { x: [10, 20], time: [100, 200] }, colors: [], drag: 'zoom',
      onPatch(update) { h.patches.push(update({ x_range: null, time_range: null })); }, onProbe() {}, onError: message => errors.push(message),
      onViewportSize: size => sizes.push(size),
    });
    for (const effect of h.effects) dispose.push(effect());
    await settled();
    assert.deepEqual(sizes, [{ width: 801, height: 501 }]);
    assert.deepEqual(h.sampling[0], { width: 1300, xRange: [10, 20], pixelRatio: 2 });
    assert.deepEqual(h.viewport, sizes[0]);
    assert.equal(h.observed, h.el);
    const rangeEvent = { 'xaxis.range[0]': 12, 'xaxis.range[1]': 14 };
    h.preview = true;
    h.el.listeners.plotly_relayout(rangeEvent);
    assert.deepEqual(h.patches, [], 'drag previews must not schedule data requests');
    h.preview = false;
    h.el.listeners.plotly_relayout(rangeEvent);
    assert.deepEqual(h.patches, [{ x_range: [12, 14], time_range: null }]);
    h.resize();
    await settled();
    assert.deepEqual(sizes.at(-1), { width: 901, height: 602 });
    assert.deepEqual(h.viewport, sizes.at(-1));
    // Re-run the render effect with the new viewport, as React does on resize.
    h.effects = [];
    h.refIndex = 0;
    SectionPlot({
      view: { view_type: 'inline', section_number: 350, x_range: [12, 14] },
      section: { x: [10, 20], time: [100, 200] }, colors: [], drag: 'zoom', onPatch() {}, onProbe() {},
      onError: message => errors.push(message), onViewportSize: size => sizes.push(size),
    });
    dispose.push(h.effects[0]());
    await settled();
    assert.deepEqual(h.sampling.at(-1), { width: 901, xRange: [12, 14], pixelRatio: 2 });
    // A committed viewport change must retain the exact data and trace objects.
    const stableSection = { x: [10, 20], time: [100, 200] };
    const stableColors = [];
    const rerender = async range => {
      h.effects = []; h.refIndex = 0;
      SectionPlot({ view: { view_type: 'inline', section_number: 350, x_range: range },
        section: stableSection, colors: stableColors, drag: 'zoom', onPatch() {}, onProbe() {},
        onError: message => errors.push(message), onViewportSize: size => sizes.push(size) });
      dispose.push(h.effects[0]());
      await settled();
    };
    await rerender([12, 14]);
    const traceBuilds = h.sampling.length;
    await rerender([13, 15]);
    assert.equal(h.sampling.length, traceBuilds, 'pure viewport changes must not rebuild data traces');
    assert.deepEqual(h.layouts.at(-1)['xaxis.range'], [13, 15]);
    const reports = sizes.length;
    for (const cleanup of dispose) cleanup();
    h.resize();
    await settled();
    assert.equal(sizes.length, reports);
    assert.equal(h.disconnected, true);
    assert.equal(h.purged, h.el);
    assert.deepEqual(errors, []);
  } finally {
    globalThis.ResizeObserver = previousObserver;
    globalThis.window = previousWindow;
    delete globalThis.sectionPlotTest;
  }
});
