import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText).toString('base64');
const react = moduleURL(`
  export function useRef(initial) { return { current: initial === null ? globalThis.sectionPlotTest.el : initial }; }
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
  export const buildLayout = (section, view) => ({ xaxis: { range: view.x_range || [10, 20] } });
`);
const display = moduleURL(await readFile(new URL('../src/components/SeismicViewer2D/sectionDisplay.ts', import.meta.url), 'utf8'));
const source = (await readFile(new URL('../src/components/SeismicViewer2D/SectionPlot.tsx', import.meta.url), 'utf8'))
  .replace('"react"', JSON.stringify(react))
  .replace('"plotly.js-dist-min"', JSON.stringify(plotly))
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
    el: { clientWidth: 1400, on() {}, removeAllListeners() {} }, effects: [], sampling: [],
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
      view: { view_type: 'inline', section_number: 350 }, section: {}, colors: [], drag: 'zoom',
      onPatch() {}, onProbe() {}, onError: message => errors.push(message),
      onViewportSize: size => sizes.push(size),
    });
    for (const effect of h.effects) dispose.push(effect());
    await settled();
    assert.deepEqual(sizes, [{ width: 801, height: 501 }]);
    assert.deepEqual(h.sampling[0], { width: 1300, xRange: [10, 20], pixelRatio: 2 });
    assert.deepEqual(h.viewport, sizes[0]);
    assert.equal(h.observed, h.el);
    h.resize();
    await settled();
    assert.deepEqual(sizes.at(-1), { width: 901, height: 602 });
    assert.deepEqual(h.viewport, sizes.at(-1));
    // Re-run the render effect with the new viewport, as React does on resize.
    h.effects = [];
    SectionPlot({
      view: { view_type: 'inline', section_number: 350, x_range: [12, 14] },
      section: {}, colors: [], drag: 'zoom', onPatch() {}, onProbe() {},
      onError: message => errors.push(message), onViewportSize: size => sizes.push(size),
    });
    dispose.push(h.effects[0]());
    await settled();
    assert.deepEqual(h.sampling.at(-1), { width: 901, xRange: [12, 14], pixelRatio: 2 });
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
