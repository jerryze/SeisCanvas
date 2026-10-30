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
    async react(el, traces, layout) {
      const h = globalThis.sectionPlotTest;
      (h.renders ??= []).push({ traces, layout });
      h.calls?.push('render:start');
      if (h.renderGate) await h.renderGate;
      el.data = traces;
      el._fullLayout = h.initialLayout;
      h.calls?.push('render:end');
    },
    async relayout(el, update) {
      const h = globalThis.sectionPlotTest;
      (h.layouts ??= []).push(update);
      h.calls?.push('resize:start');
      if (h.resizeGate) await h.resizeGate;
      el._fullLayout = h.resizedLayout;
      h.calls?.push('resize:end');
    },
    purge(el) {
      const h = globalThis.sectionPlotTest;
      h.purged = el; h.calls?.push('purge');
      (h.backdropEvents ??= []).push('purge');
    },
  };
`);
const geometry = moduleURL(`
  export const SECTION_MARGIN = { l: 72, r: 28, t: 28, b: 60 };
  export const buildTraces = (...args) => { globalThis.sectionPlotTest.sampling.push(args[4]); return []; };
  export const buildLayout = (section, view) => ({ xaxis: { range: view.x_range || [10, 20] },
    yaxis: { range: view.time_range || [200, 100], scaleanchor: false, scaleratio: 1 } });
`);
const display = moduleURL(await readFile(new URL('../src/components/SeismicViewer2D/sectionDisplay.ts', import.meta.url), 'utf8'));
const aspect = moduleURL(await readFile(new URL('../src/components/plotAspect.ts', import.meta.url), 'utf8'));
const overview = moduleURL(`
  export function buildOverviewImages(section, view, colors) {
    const h = globalThis.sectionPlotTest;
    const images = section.overview ? h.overviewImages : [];
    (h.overviewBuilds ??= []).push({ section, colors, view, images });
    return images;
  }
`);
const backdrop = moduleURL(`
  export function installRasterBackdrop(el) {
    const h = globalThis.sectionPlotTest;
    (h.backdropInstalls ??= []).push(el);
    (h.backdropEvents ??= []).push('install');
    return () => {
      (h.backdropCleanups ??= []).push(el);
      h.backdropEvents.push('cleanup');
    };
  }
`);
const scrollFrame = moduleURL(`import Plotly from ${JSON.stringify(plotly)};
  export default function Frame() {};
  export const updatePlotData = (...args) => Plotly.react(...args);
  export const isScrollPreview = () => !!globalThis.sectionPlotTest.preview;
  export const updatePlotLayout = (...args) => Plotly.relayout(...args);`);
const scrollMath = moduleURL(await readFile(new URL('../src/components/plotScrollMath.ts', import.meta.url), 'utf8'));
const source = (await readFile(new URL('../src/components/SeismicViewer2D/SectionPlot.tsx', import.meta.url), 'utf8'))
  .replace('"react"', JSON.stringify(react))
  .replace('"plotly.js-dist-min"', JSON.stringify(plotly))
  .replace('"../PlotScrollFrame"', JSON.stringify(scrollFrame))
  .replace('"../plotScrollMath"', JSON.stringify(scrollMath))
  .replace('"./sectionGeometry"', JSON.stringify(geometry))
  .replace('"../plotAspect"', JSON.stringify(aspect))
  .replace('"./overviewImages"', JSON.stringify(overview))
  .replace('"../rasterBackdrop"', JSON.stringify(backdrop))
  .replace('"./sectionDisplay"', JSON.stringify(display));
const { default: SectionPlot } = await import(moduleURL('const React = { createElement: (tag, props) => ({ tag, props }) };\n' + source));
const settled = () => new Promise(resolve => setImmediate(resolve));

test('2D renderer reports usable CSS width and height after rendering and resizing, and stops after unmount', async () => {
  const previousObserver = globalThis.ResizeObserver;
  const previousWindow = globalThis.window;
  const sizes = [];
  const errors = [];
  const h = globalThis.sectionPlotTest = {
    el: { clientWidth: 1400, clientHeight: 900, listeners: {}, on(event, handler) { this.listeners[event] = handler; },
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
    dispose.push(h.effects[1]());
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
      dispose.push(h.effects[1]());
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

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function withPlotHarness(run) {
  const previousObserver = globalThis.ResizeObserver, previousWindow = globalThis.window;
  const h = globalThis.sectionPlotTest = {
    el: { clientWidth: 1000, clientHeight: 700, listeners: {}, on(event, handler) { this.listeners[event] = handler; },
      removeAllListeners(event) { delete this.listeners[event]; } }, effects: [], sampling: [], calls: [], sizes: [], errors: [],
    initialLayout: { xaxis: { _length: 800 }, yaxis: { _length: 500 } },
    resizedLayout: { xaxis: { _length: 900 }, yaxis: { _length: 600 } },
    cleanups: [],
  };
  globalThis.window = { devicePixelRatio: 2 };
  globalThis.ResizeObserver = class {
    constructor(callback) { h.resize = callback; }
    observe() {}
    disconnect() { h.disconnected = true; }
  };
  const render = () => {
    h.effects = []; h.refIndex = 0;
    SectionPlot({ view: { view_type: 'inline', section_number: 350, ...h.view },
      section: h.section ?? { x: [10, 20], time: [100, 200] }, colors: h.colors ?? [], drag: 'zoom',
      onPatch() {}, onProbe() {}, onError: message => h.errors.push(message), onViewportSize: size => h.sizes.push(size) });
  };
  h.mount = () => { render(); h.cleanups = h.effects.map(effect => effect()); };
  h.rerender = () => { render(); h.cleanups[1]?.(); h.cleanups[1] = h.effects[1](); };
  h.unmount = () => { for (const cleanup of h.cleanups) cleanup?.(); h.cleanups = []; };
  try { await run(h); }
  finally {
    h.renderGate = null; h.resizeGate = null;
    h.unmount(); await settled();
    globalThis.ResizeObserver = previousObserver; globalThis.window = previousWindow;
    delete globalThis.sectionPlotTest;
  }
}

test('unmount waits for an in-flight render before purge and skips queued resize callbacks', () => withPlotHarness(async h => {
  const gate = deferred(); h.renderGate = gate.promise;
  h.mount(); await settled();
  assert.deepEqual(h.calls, ['render:start']);
  h.resize(); h.resize();
  h.unmount();
  assert.equal(h.purged, undefined);
  gate.resolve(); await settled();
  assert.deepEqual(h.calls, ['render:start', 'render:end', 'purge']);
  assert.equal(h.backdropInstalls?.length ?? 0, 0, 'a render completed after unmount cannot install a backdrop');
  assert.equal(h.backdropCleanups?.length ?? 0, 0);
  assert.deepEqual(h.sizes, []);
  assert.deepEqual(h.errors, []);
}));

test('unmount waits for in-flight resizing and cancels a render queued behind it', () => withPlotHarness(async h => {
  h.mount(); await settled();
  const reports = h.sizes.length;
  const gate = deferred(); h.resizeGate = gate.promise;
  h.resize(); await settled();
  assert.equal(h.calls.at(-1), 'resize:start');
  h.rerender(); await settled();
  assert.equal(h.calls.filter(call => call === 'render:start').length, 1);
  h.unmount();
  assert.equal(h.purged, undefined);
  assert.equal(h.backdropInstalls.length, 1);
  assert.equal(h.backdropCleanups.length, 1);
  assert.deepEqual(h.backdropEvents, ['install', 'cleanup']);
  gate.resolve(); await settled();
  assert.deepEqual(h.calls, ['render:start', 'render:end', 'resize:start', 'resize:end', 'purge']);
  assert.deepEqual(h.backdropEvents, ['install', 'cleanup', 'purge']);
  assert.equal(h.sizes.length, reports);
  assert.deepEqual(h.errors, []);
}));

test('resize is coalesced and serialized after a render without losing usable viewport sizes', () => withPlotHarness(async h => {
  const gate = deferred(); h.renderGate = gate.promise;
  h.mount(); await settled();
  h.resize(); h.resize(); h.resize(); await settled();
  assert.deepEqual(h.calls, ['render:start']);
  gate.resolve(); await settled();
  assert.deepEqual(h.calls, ['render:start', 'render:end', 'resize:start', 'resize:end']);
  assert.deepEqual(h.sizes, [{ width: 800, height: 500 }, { width: 900, height: 600 }]);
}));

test('resizing keeps the latest fixed plot ratio without changing the selected coordinate ranges', () => withPlotHarness(async h => {
  h.view = { aspect_ratio_2d: [2, 1], x_range: [12, 12.5], time_range: [110, 190] };
  h.mount(); await settled();
  h.el.clientWidth = 1600; h.el.clientHeight = 500;
  h.resize(); await settled();
  const layout = h.layouts.at(-1);
  const width = (1600 - 100) * (layout['xaxis.domain'][1] - layout['xaxis.domain'][0]);
  const height = (500 - 88) * (layout['yaxis.domain'][1] - layout['yaxis.domain'][0]);
  assert.ok(Math.abs(width / height - 2) < 1e-12);
  assert.equal(layout['xaxis.scaleanchor'], false);
  assert.equal(layout['yaxis.scaleanchor'], false);
  assert.equal('xaxis.range' in layout, false);
  assert.equal('yaxis.range' in layout, false);
}));

test('StrictMode effect restart purges the previous lifetime before rendering the new one', () => withPlotHarness(async h => {
  const gate = deferred(); h.renderGate = gate.promise;
  h.mount(); await settled();
  const effects = h.effects;
  h.unmount();
  h.cleanups = effects.map(effect => effect());
  h.renderGate = null; gate.resolve(); await settled();
  assert.deepEqual(h.calls, ['render:start', 'render:end', 'purge', 'render:start', 'render:end']);
  assert.deepEqual(h.backdropEvents, ['purge', 'install']);
  assert.deepEqual(h.sizes, [{ width: 800, height: 500 }]);
  assert.deepEqual(h.errors, []);
}));

test('2D renderer uses layout images for overview and does not rebuild them for viewport-only updates', () => withPlotHarness(async h => {
  h.section = { x: [10, 20], time: [100, 200], z: [[null, 8]], vmin: -10, vmax: 10,
    overview: { x: [0, 30], time: [0, 300], z: [[-20, 30]], raster_extent: [0, 30, 0, 300] } };
  h.colors = [[0, '#0000ff'], [1, '#ff0000']];
  h.view = { seismic: { reverse_colormap: true, reverse_polarity: false }, horizons: [],
    x_range: [10, 20], time_range: [100, 200] };
  h.overviewImages = [{ source: 'data:image/png;base64,overview-one', xref: 'x', yref: 'y', layer: 'below' }];
  h.mount(); await settled();
  assert.equal(h.renders.at(-1).layout.images, h.overviewImages);
  assert.equal(h.overviewBuilds.at(-1).section, h.section);
  assert.equal(h.overviewBuilds.at(-1).colors, h.colors);
  assert.equal(h.overviewBuilds.at(-1).view.seismic, h.view.seismic);
  assert.deepEqual(h.backdropInstalls, [h.el]);
  // Flush the first measured-axis update before testing a range-only rerender.
  h.rerender(); await settled();
  const imageBuilds = h.overviewBuilds.length, renders = h.renders.length;
  h.view = { ...h.view, x_range: [14, 24], time_range: [130, 230] };
  h.rerender(); await settled();
  assert.equal(h.overviewBuilds.length, imageBuilds, 'panning retains the complete existing SVG images');
  assert.equal(h.renders.length, renders, 'viewport navigation only changes Plotly layout');
  assert.deepEqual(h.layouts.at(-1)['xaxis.range'], [14, 24]);
  assert.equal('images' in h.layouts.at(-1), false, 'the fast path must not clear or replace retained images');
  assert.equal(h.renders.at(-1).layout.images, h.overviewImages);

  h.section = { ...h.section, z: [[null, 12]], raster_extent: [14, 24, 130, 230] };
  h.overviewImages = [{ source: 'data:image/png;base64,overview-two', xref: 'x', yref: 'y', layer: 'below' }];
  h.rerender(); await settled();
  assert.equal(h.overviewBuilds.length, imageBuilds + 1, 'accepted fine data reconnects the retained overview image');
  assert.equal(h.renders.at(-1).layout.images, h.overviewImages);
  assert.equal(h.overviewBuilds.at(-1).section, h.section);
  h.resize(); await settled();
  assert.deepEqual(h.backdropInstalls, [h.el], 'react, viewport changes and resizing reuse the same backdrop listeners');
  h.unmount(); await settled();
  assert.deepEqual(h.backdropCleanups, [h.el]);
  assert.deepEqual(h.backdropEvents, ['install', 'cleanup', 'purge']);
  assert.deepEqual(h.errors, []);
}));

test('a pending later render cannot reinstall the cleaned backdrop after unmount', () => withPlotHarness(async h => {
  h.mount(); await settled();
  assert.deepEqual(h.backdropInstalls, [h.el]);
  const gate = deferred(); h.renderGate = gate.promise;
  h.rerender(); await settled();
  assert.equal(h.calls.at(-1), 'render:start');
  h.unmount();
  assert.deepEqual(h.backdropCleanups, [h.el]);
  assert.equal(h.purged, undefined);
  gate.resolve(); await settled();
  assert.deepEqual(h.backdropInstalls, [h.el]);
  assert.deepEqual(h.backdropCleanups, [h.el]);
  assert.deepEqual(h.backdropEvents, ['install', 'cleanup', 'purge']);
  assert.deepEqual(h.errors, []);
}));

test('StrictMode restarts an installed backdrop once per lifetime and cleans it before purge', () => withPlotHarness(async h => {
  h.mount(); await settled();
  const effects = h.effects;
  h.unmount();
  h.cleanups = effects.map(effect => effect());
  await settled();
  assert.equal(h.backdropInstalls.length, 2);
  assert.equal(h.backdropCleanups.length, 1);
  assert.deepEqual(h.backdropEvents, ['install', 'cleanup', 'purge', 'install']);
  h.unmount(); await settled();
  assert.equal(h.backdropCleanups.length, 2);
  assert.deepEqual(h.backdropEvents, ['install', 'cleanup', 'purge', 'install', 'cleanup', 'purge']);
  assert.deepEqual(h.errors, []);
}));
