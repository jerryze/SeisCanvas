import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64');
const react = moduleURL(`
  const slot = initial => {
    const h = globalThis.sectionDataTest, i = h.cursor++;
    return h.slots[i] ??= initial();
  };
  export function useState(initial) {
    const h = globalThis.sectionDataTest, s = slot(() => ({ value: initial }));
    return [s.value, next => {
      if (h.unmounted) h.lateUpdates++;
      const value = typeof next === 'function' ? next(s.value) : next;
      if (!Object.is(value, s.value)) h.changed = true;
      s.value = value;
    }];
  }
  export const useRef = initial => slot(() => ({ current: initial }));
  export function useEffect(effect, deps) {
    const h = globalThis.sectionDataTest, s = slot(() => ({}));
    if (!s.deps || deps.some((value, i) => !Object.is(value, s.deps[i])))
      h.pending.push(() => { s.cleanup?.(); s.deps = deps; s.cleanup = effect(); });
  }
  export function useCallback(callback, deps) {
    const s = slot(() => ({}));
    if (!s.deps || deps.some((value, i) => !Object.is(value, s.deps[i]))) { s.deps = deps; s.callback = callback; }
    return s.callback;
  }
`);
const api = moduleURL(`
  export const json = value => ({ method: 'POST', body: JSON.stringify(value) });
  export const api = (path, init) => new Promise((resolve, reject) =>
    globalThis.sectionDataTest.requests.push({ path, init, resolve, reject }));
`);
const raster = moduleURL(await readFile(new URL('../src/components/loadedRaster.ts', import.meta.url), 'utf8'));
const display = moduleURL(await readFile(new URL('../src/components/SeismicViewer2D/sectionDisplay.ts', import.meta.url), 'utf8'));
const cache = moduleURL((await readFile(new URL('../src/hooks/sectionViewportCache.ts', import.meta.url), 'utf8'))
  .replace('"../components/loadedRaster"', JSON.stringify(raster)));
const source = (await readFile(new URL('../src/hooks/useSectionData.ts', import.meta.url), 'utf8'))
  .replace('"react"', JSON.stringify(react)).replace('"../api/client"', JSON.stringify(api))
  .replace('"../components/loadedRaster"', JSON.stringify(raster))
  .replace('"./sectionViewportCache"', JSON.stringify(cache))
  .replace('"../components/SeismicViewer2D/sectionDisplay"', JSON.stringify(display));
const { useSectionData } = await import(moduleURL(source));
const { sectionContentKey } = await import(display);
const settled = () => new Promise(resolve => setImmediate(resolve));

const makeMeta = () => ({ inlines: [350, 351], crosslines: [10, 20], time_range: [100, 200] });
const makeView = () => ({
  view_mode: '2d', view_type: 'inline', section_number: 350, x_range: null, time_range: null,
  horizon_sg: false, horizon_sg_window: 7, horizons: [],
  seismic: { clip_mode: 'percentile', clip_percentile: 99.5, symmetric: true, vmin: -10, vmax: 10,
    reverse_polarity: false, wiggle: false, variable_area: false, wiggle_gain: 1,
    variable_area_color: '#000000', background_interpolation: true, wiggle_interpolation: true },
});
const makeSection = patch => ({
  x: [10, 20], time: [100, 200], z: [[1, 2], [3, 4]], horizons: {}, vmin: -10, vmax: 10,
  raster_extent: [5, 25, 100, 200], preview_shape: [512, 1024],
  background_interpolation: true, interpolation: 'sinc8', wiggle_interpolation: true, ...patch,
});
const makeOverview = () => ({
  x: [10, 20], time: [100, 200], x_edges: [5, 15, 25], time_edges: [100, 150, 200],
  raster_extent: [5, 25, 100, 200], z: [[1, 2], [3, 4]],
});

async function withHarness(run) {
  const saved = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, window: globalThis.window };
  let now = 0, next = 0;
  const h = globalThis.sectionDataTest = { slots: [], pending: [], requests: [], timers: new Map(), errors: [], lateUpdates: 0,
    box: { clientWidth: 600, clientHeight: 300 }, props: { meta: makeMeta(), view: makeView(), revision: 0 } };
  globalThis.window = { devicePixelRatio: 2 };
  globalThis.setTimeout = (callback, delay) => { h.timers.set(++next, { callback, due: now + delay }); return next; };
  globalThis.clearTimeout = id => h.timers.delete(id);
  h.render = patch => {
    h.props = { ...h.props, ...patch };
    do {
      h.changed = false; h.cursor = 0; h.pending = [];
      h.result = useSectionData(h.props.meta, h.props.view, h.props.revision, message => h.errors.push(message));
      h.result.plotWrap.current = h.box;
      for (const effect of h.pending) effect();
    } while (h.changed);
    return h.result;
  };
  h.advance = wait => {
    now += wait;
    for (const [id, { callback, due }] of [...h.timers]) if (due <= now) { h.timers.delete(id); void callback(); }
  };
  h.complete = async (index, data = makeSection()) => {
    h.requests[index].resolve({ json: async () => data });
    await settled();
    if (!h.unmounted) h.render();
  };
  h.measure = value => { h.result.measuredSectionViewport(value); h.render(); };
  h.unmount = () => {
    for (const s of h.slots) s.cleanup?.();
    h.unmounted = true;
  };
  try { h.render(); await run(h); }
  finally { if (!h.unmounted) h.unmount(); Object.assign(globalThis, saved); delete globalThis.sectionDataTest; }
}

test('section requests debounce 200 ms and use the latest view and measured CSS viewport', () => withHarness(async h => {
  h.advance(199);
  assert.equal(h.requests.length, 0);
  h.measure({ width: 400, height: 200 });
  const view = { ...h.props.view, section_number: 351 };
  h.render({ view }); h.advance(199);
  assert.equal(h.requests.length, 0);
  h.advance(1);
  assert.equal(h.requests.length, 1);
  const body = JSON.parse(h.requests[0].init.body);
  assert.equal(body.section_number, 351);
  assert.equal(body.quality, 'interactive');
  assert.deepEqual([body.target_width, body.target_height], [800, 400]);
  assert.deepEqual([body.trace_viewport_width, body.trace_viewport_height], [400, 200]);
  const data = makeSection(); await h.complete(0, data);
  assert.equal(h.result.section, data);
  assert.equal(h.result.loading, false);
  assert.deepEqual(h.errors, ['']);
}));

test('covered interpolated zoom is temporary while exact view switches reuse the accepted raster', () => withHarness(async h => {
  h.measure({ width: 400, height: 200 }); h.advance(200);
  const data = makeSection(); await h.complete(0, data);
  h.render({ view: { ...h.props.view, x_range: [7, 23] } }); h.advance(200);
  assert.equal(h.requests.length, 2);
  assert.equal(h.result.section, data);
  assert.equal(h.result.loading, true, 'a shifted interpolation grid still needs its own precise amplitudes');
  const zoom = makeSection({ raster_extent: [7, 23, 100, 200], z: [[1.23456789, null], [9, 4]] });
  await h.complete(1, zoom);
  assert.equal(h.result.section, zoom);
  h.render({ view: { ...h.props.view, view_mode: '3d' } });
  assert.equal(h.result.section, zoom);
  h.render({ view: { ...h.props.view, view_mode: '2d' } }); h.advance(200);
  assert.equal(h.requests.length, 2);
  h.render({ view: { ...h.props.view, x_range: [10, 11] } });
  assert.equal(h.result.section, zoom, 'keep the current raster during refresh');
  h.advance(200);
  assert.equal(h.requests.length, 3);
}));

test('Variable Area color is a local edit even with overlays enabled or a request in flight', () => withHarness(async h => {
  h.render({ view: { ...h.props.view, seismic: { ...h.props.view.seismic, variable_area: true } } });
  h.advance(200);
  const signal = h.requests[0].init.signal;
  h.render({ view: { ...h.props.view, seismic: { ...h.props.view.seismic, variable_area_color: '#aa1122' } } });
  assert.equal(signal.aborted, false);
  await h.complete(0, makeSection({ trace_overlay: { wiggle: { x: [], time: [] }, variable_area: { x: [], time: [] } } }));
  h.render({ view: { ...h.props.view, seismic: { ...h.props.view.seismic, variable_area_color: '#1122aa' } } });
  h.advance(200);
  assert.equal(h.requests.length, 1);
  assert.equal(h.result.loading, false);
}));

test('switching sections or leaving 2D aborts requests and ignores late body parsing', () => withHarness(async h => {
  h.advance(200);
  h.render({ view: { ...h.props.view, section_number: 351 } });
  assert.equal(h.requests[0].init.signal.aborted, true);
  h.advance(200);
  const latest = makeSection({ vmin: -20 }); await h.complete(1, latest);
  await h.complete(0);
  assert.equal(h.result.section, latest);
  h.render({ view: { ...h.props.view, section_number: 350 } }); h.advance(200);
  assert.equal(h.result.section, null, 'the previous section cannot remain under the new section title');
  h.render({ view: { ...h.props.view, view_mode: 'map' } });
  assert.equal(h.requests[2].init.signal.aborted, true);
  await h.complete(2);
  assert.equal(h.result.section, null);
  assert.equal(h.result.loading, false);
}));

test('workspace recovery clears cached data and pending work but retains measured export CSS sizes', () => withHarness(async h => {
  h.measure({ width: 400, height: 200 }); h.advance(200); await h.complete(0);
  h.render({ view: { ...h.props.view, section_number: 351 } }); h.advance(200);
  h.result.resetSection(); h.render();
  assert.equal(h.result.section, null);
  assert.equal(h.requests[1].init.signal.aborted, true);
  assert.deepEqual(h.result.sectionViewportRef.current, { width: 400, height: 200 });
  await h.complete(1);
  assert.equal(h.result.section, null);
  h.render({ meta: makeMeta(), revision: 1 }); h.advance(200);
  assert.equal(h.requests.length, 3);
  await h.complete(2);
  assert.ok(h.result.section);
}));

test('native cells reuse exact data at any covered zoom and only relevant viewport sizes resample', () => withHarness(async h => {
  h.render({ view: { ...h.props.view, seismic: { ...h.props.view.seismic, background_interpolation: false } } });
  h.advance(200);
  await h.complete(0, makeSection({ background_interpolation: false, interpolation: 'native' }));
  h.measure({ width: 3000, height: 2000 });
  h.render({ view: { ...h.props.view, x_range: [10, 10.01], time_range: [150, 150.01] } }); h.advance(200);
  assert.equal(h.requests.length, 1);
}));

test('compatibility and SG failures report existing messages while aborted or unmounted work stays silent', () => withHarness(async h => {
  h.advance(200);
  await h.complete(0, makeSection({ interpolation: 'bilinear' }));
  assert.match(h.errors.at(-1), /二维显示后端版本不匹配/);
  assert.equal(h.result.section, null);
  h.render({ view: { ...h.props.view, horizon_sg: true } }); h.advance(200); await h.complete(1);
  assert.equal(h.errors.at(-1), '层位平滑不可用，请重启 SeisCanvas。');
  h.render({ revision: 1 }); h.advance(200);
  h.requests[2].reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
  await settled(); h.render();
  assert.equal(h.errors.length, 2);
  h.render({ revision: 2 }); h.advance(200);
  h.unmount();
  assert.equal(h.requests[3].init.signal.aborted, true);
  await h.complete(3);
  assert.equal(h.lateUpdates, 0);
  assert.equal(h.errors.length, 2);
}));

test('unmount before the debounce expires prevents any request', () => withHarness(async h => {
  h.unmount(); h.advance(200);
  assert.equal(h.timers.size, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.lateUpdates, 0);
}));

test('content identity includes scientific fields and revision but excludes display-only edits', () => {
  const view = makeView(), key = sectionContentKey(view, 0);
  for (const name of ['colormap', 'reverse_colormap', 'variable_area_color'])
    assert.equal(sectionContentKey({ ...view, seismic: { ...view.seismic, [name]: 'changed' } }, 0), key);
  for (const name of ['clip_mode', 'clip_percentile', 'symmetric', 'vmin', 'vmax', 'reverse_polarity',
    'wiggle', 'variable_area', 'wiggle_gain', 'background_interpolation', 'wiggle_interpolation'])
    assert.notEqual(sectionContentKey({ ...view, seismic: { ...view.seismic, [name]: 'changed' } }, 0), key);
  for (const name of ['view_type', 'section_number', 'horizon_sg', 'horizon_sg_window'])
    assert.notEqual(sectionContentKey({ ...view, [name]: 'changed' }, 0), key);
  assert.notEqual(sectionContentKey(view, 1), key);
});

test('navigation keeps a shared overview while detailed requests debounce and load', () => withHarness(async h => {
  h.measure({ width: 400, height: 200 }); h.advance(200);
  assert.equal(JSON.parse(h.requests[0].init.body).include_overview, true);
  const overview = makeOverview();
  const initial = makeSection({ overview }); await h.complete(0, initial);
  h.render({ view: { ...h.props.view, x_range: [10, 11] } }); h.advance(199);
  assert.equal(h.requests.length, 1);
  assert.equal(h.result.section, initial);
  h.advance(1);
  assert.equal(JSON.parse(h.requests[1].init.body).include_overview, false);
  assert.equal(h.result.section.overview, overview);
  const fine = makeSection({ raster_extent: [10, 11, 100, 200], z: [[8, 9], [10, 11]] });
  await h.complete(1, fine);
  assert.equal(h.result.section.overview, overview);
  assert.equal(h.result.section.z, fine.z, 'detail values are never replaced by overview values');
  assert.equal(h.result.section.vmin, initial.vmin);
  assert.equal(h.result.section.vmax, initial.vmax);
}));

test('rapid pan ignores stale body parsing and preserves the overview on a failed refresh', () => withHarness(async h => {
  h.measure({ width: 400, height: 200 }); h.advance(200);
  const overview = makeOverview(); await h.complete(0, makeSection({ overview }));
  h.render({ view: { ...h.props.view, x_range: [10, 11] } }); h.advance(200);
  let finishBody;
  h.requests[1].resolve({ json: () => new Promise(resolve => { finishBody = resolve; }) });
  await settled();
  h.render({ view: { ...h.props.view, x_range: [12, 13] } });
  h.advance(100);
  h.render({ view: { ...h.props.view, x_range: [14, 15] } });
  h.advance(200);
  assert.equal(h.requests.length, 3, 'the intermediate pan is debounced');
  assert.equal(h.requests[1].init.signal.aborted, true);
  const latest = makeSection({ raster_extent: [14, 15, 100, 200], z: [[20]] });
  await h.complete(2, latest);
  finishBody(makeSection({ overview: makeOverview(), z: [[-999]] }));
  await settled(); h.render();
  assert.equal(h.result.section.z, latest.z);
  assert.equal(h.result.section.overview, overview);
  h.render({ view: { ...h.props.view, x_range: [16, 17] } }); h.advance(200);
  h.requests[3].reject(new Error('network unavailable'));
  await settled(); h.render();
  assert.equal(h.result.section.z, latest.z);
  assert.equal(h.result.section.overview, overview);
  assert.equal(h.result.loading, false);
  assert.equal(h.errors.at(-1), 'network unavailable');
}));

test('zooming and panning back reuses recent precise windows without a network request', () => withHarness(async h => {
  h.measure({ width: 400, height: 200 }); h.advance(200);
  const full = makeSection({ overview: makeOverview() }); await h.complete(0, full);
  h.render({ view: { ...h.props.view, x_range: [10, 11] } }); h.advance(200);
  const first = makeSection({ raster_extent: [10, 11, 100, 200] }); await h.complete(1, first);
  h.render({ view: { ...h.props.view, x_range: [12, 13] } }); h.advance(200);
  await h.complete(2, makeSection({ raster_extent: [12, 13, 100, 200] }));
  h.render({ view: { ...h.props.view, x_range: [10, 11] } }); h.advance(200);
  assert.equal(h.requests.length, 3);
  assert.equal(h.result.section.z, first.z);
  h.render({ view: { ...h.props.view, x_range: [10.05, 10.95] } }); h.advance(200);
  assert.equal(h.requests.length, 4, 'a nearby interpolated view requests its own sampling centres');
  assert.equal(h.result.section.z, first.z, 'the cached window is available immediately as a transition');
  assert.equal(h.result.loading, true);
  h.render({ view: { ...h.props.view, x_range: null } }); h.advance(200);
  assert.equal(h.requests.length, 4);
  assert.equal(h.requests[3].init.signal.aborted, true);
  assert.equal(h.result.section, full);
  assert.equal(h.result.loading, false);
}));

test('overlay caches require identical viewport geometry, including measured size', () => withHarness(async h => {
  h.measure({ width: 400, height: 200 });
  h.render({ view: { ...h.props.view, seismic: { ...h.props.view.seismic, wiggle: true } } });
  h.advance(200);
  const trace_overlay = { wiggle: { x: [10], time: [100] }, variable_area: { x: [], time: [] } };
  const full = makeSection({ overview: makeOverview(), trace_overlay }); await h.complete(0, full);
  h.render({ view: { ...h.props.view, x_range: [7, 23] } }); h.advance(200);
  assert.equal(h.requests.length, 2, 'raster coverage cannot stand in for requested waveform geometry');
  await h.complete(1, makeSection({ trace_overlay }));
  h.render({ view: { ...h.props.view, x_range: null } }); h.advance(200);
  assert.equal(h.requests.length, 2);
  assert.equal(h.result.section, full);
  h.measure({ width: 401, height: 200 }); h.advance(200);
  assert.equal(h.requests.length, 3);
  assert.equal(JSON.parse(h.requests[2].init.body).trace_viewport_width, 401);
}));

test('metadata, scientific settings, revision and reset invalidate overview and cached windows', () => withHarness(async h => {
  h.measure({ width: 400, height: 200 }); h.advance(200);
  await h.complete(0, makeSection({ overview: makeOverview() }));
  const changes = [
    () => ({ meta: makeMeta() }),
    () => ({ view: { ...h.props.view, seismic: { ...h.props.view.seismic, reverse_polarity: true } } }),
    () => ({ revision: 1 }),
  ];
  for (const change of changes) {
    const patch = change();
    h.render(patch);
    if (patch.meta) assert.equal(h.result.section, null);
    else assert.equal(h.result.section.overview, undefined);
    h.advance(200);
    const index = h.requests.length - 1;
    assert.equal(JSON.parse(h.requests[index].init.body).include_overview, true);
    const overview = makeOverview(); await h.complete(index, makeSection({ overview }));
    assert.equal(h.result.section.overview, overview);
  }
  h.result.resetSection(); h.render();
  assert.equal(h.result.section, null);
  h.render({ revision: 2 }); h.advance(200);
  assert.equal(JSON.parse(h.requests.at(-1).init.body).include_overview, true);
}));

test('changing source, section number or direction immediately hides old amplitudes and ignores failed replacements', () => withHarness(async h => {
  h.advance(200); await h.complete(0, makeSection({ overview: makeOverview() }));
  const changes = [
    () => ({ view: { ...h.props.view, section_number: 351 } }),
    () => ({ view: { ...h.props.view, view_type: 'crossline', section_number: 20 } }),
    () => ({ meta: makeMeta() }),
  ];
  for (const change of changes) {
    h.render(change());
    assert.equal(h.result.section, null);
    h.advance(200);
    const index = h.requests.length - 1;
    h.requests[index].reject(new Error('replacement unavailable'));
    await settled(); h.render();
    assert.equal(h.result.section, null, 'a failed replacement cannot reveal the previous source');
    h.render({ revision: h.props.revision + 1 }); h.advance(200);
    await h.complete(h.requests.length - 1, makeSection({ overview: makeOverview() }));
  }
}));
