import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(compile(source)).toString('base64');
const styles = moduleURL(await readFile(new URL('../src/components/plotStyle.ts', import.meta.url), 'utf8'));
const curve = moduleURL(await readFile(new URL('../src/components/SeismicViewer2D/horizonCurve.ts', import.meta.url), 'utf8'));
const source = (await readFile(new URL('../src/components/SeismicViewer2D/sectionGeometry.ts', import.meta.url), 'utf8'))
  .replace('"../plotStyle"', JSON.stringify(styles))
  .replace('"./horizonCurve"', JSON.stringify(curve));
const { buildTraces, buildLayout } = await import(moduleURL(source));
const { measureSectionViewport, samplingViewport, sectionResponseError } = await import(moduleURL(
  await readFile(new URL('../src/components/SeismicViewer2D/sectionDisplay.ts', import.meta.url), 'utf8'),
));

const colors = [[0, '#0000ff'], [1, '#ff0000']];
const horizon = {
  id: 'h', name: 'Horizon', visible: true, color: '#ff8800',
  line: { visible: true, width: 1, style: 'solid' },
  marker: { visible: false, shape: 'none', size: 2 },
  outline: { enabled: true, width: 0.5 },
};
function state(patch = {}) {
  return {
    view_mode: '2d', view_type: 'inline', section_number: 350,
    x_range: null, time_range: null, aspect_ratio_2d: null,
    seismic: {
      reverse_colormap: false, reverse_polarity: false, wiggle: false,
      variable_area: false, wiggle_gain: 1, variable_area_color: '#000000',
      background_interpolation: true, wiggle_interpolation: true, ...patch,
    },
    horizons: [horizon],
  };
}
function data() {
  return {
    // An interpolated color raster with different sample positions from the paths.
    x: [10, 10.5, 11], time: [100, 102], z: [[1, 0, -1], [-2, 0, 2]],
    vmin: -2, vmax: 2, horizons: { h: [[10, 100], [11, 102]] },
    interpolation: 'sinc8', background_interpolation: true, wiggle_interpolation: true,
    trace_overlay: {
      wiggle: { x: [10.2, 9.8, null, 10.6, 11.4], time: [100, 102, null, 100, 102] },
      variable_area: { x: [10, 10.2, 10, null, 11, 11.4, 11], time: [100, 100, 101, null, 101, 102, 102] },
      trace_step: 1, trace_count: 2, viewport_width: 1000,
    },
  };
}

test('disabled overlays preserve the existing color background and horizons', () => {
  const section = data();
  const traces = buildTraces(section, state(), colors);
  assert.equal(traces.length, 3);
  assert.equal(traces[0].type, 'heatmap');
  assert.equal(traces[0].z, section.z);
  assert.deepEqual(traces[0].colorscale, colors);
  assert.equal(traces.at(-1).name, 'Horizon');
  assert.ok(traces.slice(1).every(trace => !trace.fill));
});

test('hollow circles use a white fill and coloured ring in sections and A–B profiles without black outlines', () => {
  for (const horizontalLabel of [undefined, '距离 (网格)']) {
    for (const enabled of [false, true]) {
      const view = state();
      view.horizons = [{ ...horizon, outline: { enabled, width: 0 },
        marker: { visible: true, shape: 'circle-open', size: 5 } }];
      const trace = buildTraces(data(), view, colors, horizontalLabel).at(-1);
      assert.equal(trace.mode, 'lines+markers');
      assert.equal(trace.marker.symbol, 'circle');
      assert.equal(trace.marker.color, '#fff');
      assert.equal(trace.marker.line.color, horizon.color);
      assert.equal(trace.marker.line.width, 1);
      assert.deepEqual(trace.x, [10, 11]);
      assert.deepEqual(trace.y, [100, 102]);
    }
  }
});

test('smoothing changes only visible line geometry, retaining raw markers and hover picks', () => {
  const section = data();
  section.horizons.h = [[10, 100.125], [10.4, 101.875], [11, 102.25]];
  const before = structuredClone(section);
  const view = state();
  view.smooth_horizons = true;
  view.horizons = [{ ...horizon,
    marker: { visible: true, shape: 'circle', size: 2 } }];
  const viewport = { width: 100, xRange: [10, 11], pixelRatio: 2 };
  const traces = buildTraces(section, view, colors, undefined, viewport);
  const [outline, curve, picks] = traces.slice(1);
  assert.deepEqual(outline.x, curve.x);
  assert.deepEqual(outline.y, curve.y);
  assert.ok(curve.x.length > section.horizons.h.length);
  for (const trace of [outline, curve]) {
    assert.equal(trace.hoverinfo, 'skip');
    assert.equal(trace.mode, 'lines');
    assert.equal(trace.line.simplify, false);
    assert.equal(trace.line.shape, 'linear');
    for (const [x, y] of section.horizons.h) assert.equal(trace.y[trace.x.indexOf(x)], y);
  }
  assert.deepEqual(picks.x, section.horizons.h.map(p => p[0]));
  assert.deepEqual(picks.y, section.horizons.h.map(p => p[1]));
  assert.equal(picks.mode, 'lines+markers');
  assert.equal(picks.line.width, 0);
  assert.equal(picks.marker.size, 8 / 3);
  assert.deepEqual(section, before);
  for (const smooth_horizons of [false, undefined]) {
    view.smooth_horizons = smooth_horizons;
    view.horizons = [horizon];
    const raw = buildTraces(section, view, colors, undefined, viewport);
    assert.equal(raw.length, 3);
    assert.deepEqual(raw.at(-1).x, picks.x);
    assert.deepEqual(raw.at(-1).y, picks.y);
    assert.equal(raw.at(-1).line.simplify, false);
  }
});

test('2D smoothing preference has no effect on A–B profiles or marker-only horizons', () => {
  const view = state();
  view.smooth_horizons = true;
  view.horizons = [horizon];
  assert.equal(buildTraces(data(), view, colors, '距离 (网格)').length, 3);
  view.horizons = [{ ...view.horizons[0], line: { ...horizon.line, visible: false },
    marker: { visible: true, shape: 'circle', size: 2 } }];
  const traces = buildTraces(data(), view, colors, undefined, { width: 100, xRange: [10, 11] });
  assert.equal(traces.length, 2);
  assert.equal(traces[1].mode, 'markers');
  assert.deepEqual(traces[1].x, [10, 11]);
});

test('one shared switch smooths all visible horizons, including newly shown ones', () => {
  const view = state();
  view.horizons = [horizon, { ...horizon, id: 'second', name: 'Second', visible: false }];
  const section = data();
  section.horizons.second = [[10, 110.25], [10.5, 112.875], [11, 111.125]];
  const viewport = { width: 100, xRange: [10, 11] };
  view.smooth_horizons = true;
  assert.equal(buildTraces(section, view, colors, undefined, viewport).length, 4);
  view.horizons[1] = { ...view.horizons[1], visible: true };
  const traces = buildTraces(section, view, colors, undefined, viewport);
  assert.equal(traces.length, 7);
  for (const offset of [1, 4]) {
    assert.ok(traces[offset].x.length > section.horizons[view.horizons[(offset - 1) / 3].id].length);
    assert.deepEqual(traces[offset].x, traces[offset + 1].x);
    assert.equal(traces[offset + 2].line.width, 0);
  }
  view.smooth_horizons = false;
  const raw = buildTraces(section, view, colors, undefined, viewport);
  assert.equal(raw.length, 5);
  assert.deepEqual(raw[2].y, section.horizons.h.map(p => p[1]));
  assert.deepEqual(raw[4].y, section.horizons.second.map(p => p[1]));
});

test('Wiggle and Variable Area can be enabled independently', () => {
  const section = data();
  const wiggle = buildTraces(section, state({ wiggle: true }), colors);
  assert.equal(wiggle.length, 4);
  assert.equal(wiggle[1].x, section.trace_overlay.wiggle.x);
  assert.equal(wiggle[1].fill, undefined);
  assert.equal(wiggle[1].line.color, '#000000');
  assert.equal(wiggle[1].line.width, 0.8);
  const area = buildTraces(section, state({ variable_area: true }), colors);
  assert.equal(area.length, 4);
  assert.equal(area[1].x, section.trace_overlay.variable_area.x);
  assert.equal(area[1].fill, 'toself');
  assert.equal(area[1].fillcolor, '#000000');
  assert.equal(area[1].line.width, 0);
});

test('SG changes only visible time geometry and disables instantly without replacing raw picks', () => {
  const section = data();
  section.horizon_display = { algorithm: 'sg', window: 7, view_type: 'inline', section_number: 350,
    points: { h: [[10, 100.375], [null, null], [11, 101.825]] } };
  const before = structuredClone(section);
  const view = state();
  view.horizon_sg = true;
  view.horizons = [{ ...horizon, marker: { visible: true, shape: 'circle', size: 2 } }];
  const viewport = { width: 100, xRange: [10, 11] };
  const traces = buildTraces(section, view, colors, undefined, viewport);
  assert.deepEqual(traces[1].x, [10, null, 11]);
  assert.deepEqual(traces[1].y, [100.375, null, 101.825]);
  assert.deepEqual(traces[2].y, traces[1].y);
  assert.equal(traces[2].hoverinfo, 'skip');
  assert.deepEqual(traces[3].y, [100, 102]);
  assert.equal(traces[3].line.width, 0);
  assert.equal(traces[3].mode, 'lines+markers');
  view.horizon_sg = false;
  assert.deepEqual(buildTraces(section, view, colors, undefined, viewport).at(-1).y, [100, 102]);
  assert.deepEqual(section, before);
});

test('SG window, direction and position must match the response before it can be drawn', () => {
  const section = data();
  section.horizon_display = { algorithm: 'sg', window: 7, view_type: 'inline', section_number: 350,
    points: { h: [[10, 100.375], [11, 101.825]] } };
  const viewport = { width: 100, xRange: [10, 11] };
  for (const patch of [{ horizon_sg_window: 5 }, { view_type: 'crossline' }, { section_number: 351 }]) {
    const view = { ...state(), horizon_sg: true, ...patch };
    assert.equal(buildTraces(section, view, colors, undefined, viewport).length, 3);
    assert.deepEqual(buildTraces(section, view, colors, undefined, viewport).at(-1).y, [100, 102]);
  }
  const view = { ...state(), horizon_sg: true, smooth_horizons: true };
  const curve = buildTraces(section, view, colors, undefined, viewport)[2];
  assert.equal(curve.y[0], 100.375);
  assert.equal(curve.y.at(-1), 101.825);
  assert.ok(curve.x.length > 2);
});

test('area and waveform use exact backend coordinates and render below every horizon', () => {
  const section = data();
  const traces = buildTraces(section, state({ variable_area: true, wiggle: true, variable_area_color: '#123456' }), colors);
  assert.equal(traces.length, 5);
  assert.equal(traces[0].type, 'heatmap');
  assert.equal(traces[1].fill, 'toself');
  assert.equal(traces[1].fillcolor, '#123456');
  assert.equal(traces[1].x, section.trace_overlay.variable_area.x);
  assert.equal(traces[1].y, section.trace_overlay.variable_area.time);
  assert.equal(traces[2].x, section.trace_overlay.wiggle.x);
  assert.equal(traces[2].y, section.trace_overlay.wiggle.time);
  assert.equal(traces[3].line.color, '#000');
  assert.equal(traces[4].name, 'Horizon');
  for (const trace of traces.slice(1, 3)) {
    assert.equal(trace.connectgaps, false);
    assert.equal(trace.hoverinfo, 'skip');
    assert.equal(trace.line.simplify, false);
    assert.equal(trace.cliponaxis, true);
    assert.equal(trace.showlegend, false);
  }
});

test('raster polarity changes do not reverse or rescale backend waveform paths twice', () => {
  const section = data();
  const before = structuredClone(section);
  const traces = buildTraces(section, state({ variable_area: true, wiggle: true, reverse_polarity: true, wiggle_gain: 20 }), colors);
  assert.deepEqual(traces[0].z, [[-1, -0, 1], [2, -0, -2]]);
  assert.deepEqual(traces[1].x, before.trace_overlay.variable_area.x);
  assert.deepEqual(traces[2].x, before.trace_overlay.wiggle.x);
  assert.deepEqual(section, before);
});

test('missing or empty overlay paths remain compatible with section responses', () => {
  const section = data();
  section.trace_overlay = null;
  assert.equal(buildTraces(section, state({ wiggle: true, variable_area: true }), colors).length, 3);
  section.trace_overlay = { wiggle: { x: [], time: [] }, variable_area: { x: [], time: [] } };
  assert.equal(buildTraces(section, state({ wiggle: true, variable_area: true }), colors).length, 3);
});

test('axes render above overlays while trace and TWT ranges and aspect stay unchanged', () => {
  const view = state({ wiggle: true, variable_area: true });
  view.x_range = [10.2, 10.8];
  view.time_range = [100.5, 101.5];
  view.aspect_ratio_2d = [2, 1];
  const layout = buildLayout(data(), view, 'pan');
  assert.equal(layout.xaxis.layer, 'above traces');
  assert.equal(layout.yaxis.layer, 'above traces');
  assert.deepEqual(layout.xaxis.range, [10.2, 10.8]);
  assert.deepEqual(layout.yaxis.range, [101.5, 100.5]);
  assert.equal(layout.yaxis.scaleanchor, 'x');
  assert.ok(Math.abs(layout.yaxis.scaleratio - 0.3) < 1e-12);
});

test('all 2D interpolation and overlay modes keep native coordinate ranges independent of render centres', () => {
  const section = data();
  section.x = [10.1, 10.9];
  section.time = [100.2, 101.8];
  section.raster_extent = [9.5, 11.5, 99, 103];
  section.window = { x_range: [10, 11], time_range: [100, 102] };
  for (const wiggle of [false, true]) {
    for (const background_interpolation of [false, true]) {
      const layout = buildLayout(section, state({ wiggle, background_interpolation }), 'zoom');
      assert.deepEqual(layout.xaxis.range, [9.5, 11.5]);
      assert.deepEqual(layout.yaxis.range, [102, 100]);
    }
  }
});

test('native background passes exact nonuniform cell edges and amplitudes without browser interpolation', () => {
  const section = data();
  section.x = [10, 13, 18];
  section.time = [100, 102];
  section.x_edges = [8.5, 11.5, 15.5, 20.5];
  section.time_edges = [99, 101, 103];
  section.z[0][1] = null;
  section.interpolation = 'native';
  section.background_interpolation = false;
  for (const wiggle_interpolation of [false, true]) {
    const view = state({ background_interpolation: false, wiggle: true, wiggle_interpolation });
    const [background, wiggle] = buildTraces(section, view, colors);
    assert.equal(background.x, section.x_edges);
    assert.equal(background.y, section.time_edges);
    assert.equal(background.z, section.z);
    assert.equal(background.zsmooth, false);
    assert.equal(wiggle.x, section.trace_overlay.wiggle.x);
    view.seismic.reverse_polarity = true;
    assert.equal(buildTraces(section, view, colors)[0].z[0][1], null);
  }
});

test('viewport sampling uses inner CSS axis sizes and ignores invalid/uninitialised layouts', () => {
  assert.deepEqual(measureSectionViewport({
    width: 1400, height: 1000, xaxis: { _length: 1200.4 }, yaxis: { _length: 812.7 },
  }), { width: 1200, height: 813 });
  assert.equal(measureSectionViewport(null), null);
  assert.equal(measureSectionViewport({ xaxis: { _length: 0 }, yaxis: { _length: 100 } }), null);
  assert.equal(measureSectionViewport({ xaxis: { _length: 100 }, yaxis: { _length: NaN } }), null);
});

test('resize resamples background and waveform independently while raw native paths only update density', () => {
  const viewport = { width: 1000, height: 750 };
  assert.deepEqual(samplingViewport(state().seismic, viewport), viewport);
  assert.deepEqual(samplingViewport(state({ background_interpolation: false }).seismic, viewport), { width: null, height: null });
  assert.deepEqual(samplingViewport(state({ background_interpolation: false, wiggle: true }).seismic, viewport), viewport);
  assert.deepEqual(samplingViewport(state({ background_interpolation: false, variable_area: true, wiggle_interpolation: false }).seismic, viewport), { width: 1000, height: null });
  assert.deepEqual(samplingViewport(state().seismic, null), { width: null, height: null });
});

test('a stale backend gives an explicit restart error for requested interpolation or missing overlays', () => {
  const current = data();
  assert.equal(sectionResponseError(current, state().seismic), null);
  const old = { ...current };
  delete old.background_interpolation;
  delete old.wiggle_interpolation;
  old.interpolation = 'bilinear';
  assert.match(sectionResponseError(old, state().seismic), /重启 SeisCanvas 后端/);
  assert.match(sectionResponseError(old, state({ background_interpolation: false, wiggle: true }).seismic), /重启/);
  assert.equal(sectionResponseError(old, state({ background_interpolation: false }).seismic), null);
  assert.match(sectionResponseError({ ...current, trace_overlay: null }, state({ variable_area: true }).seismic), /重启/);
  const native = { ...current, interpolation: 'native', background_interpolation: false, wiggle_interpolation: false };
  assert.equal(sectionResponseError(native, state({ background_interpolation: false, wiggle_interpolation: false, wiggle: true }).seismic), null);
  assert.match(sectionResponseError(native, state({ background_interpolation: false, wiggle: true }).seismic), /重启/);
});
