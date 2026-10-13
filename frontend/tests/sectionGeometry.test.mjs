import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(compile(source)).toString('base64');
const styles = moduleURL(await readFile(new URL('../src/components/plotStyle.ts', import.meta.url), 'utf8'));
const source = (await readFile(new URL('../src/components/SeismicViewer2D/sectionGeometry.ts', import.meta.url), 'utf8'))
  .replace('"../plotStyle"', JSON.stringify(styles));
const { buildTraces, buildLayout } = await import(moduleURL(source));

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
      variable_area: false, wiggle_gain: 1, variable_area_color: '#000000', ...patch,
    },
    horizons: [horizon],
  };
}
function data() {
  return {
    // An interpolated color raster with different sample positions from the paths.
    x: [10, 10.5, 11], time: [100, 102], z: [[1, 0, -1], [-2, 0, 2]],
    vmin: -2, vmax: 2, horizons: { h: [[10, 100], [11, 102]] },
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

test('overlay raster keeps native coordinate ranges independently of resampled pixel centres', () => {
  const section = data();
  section.x = [10.1, 10.9];
  section.time = [100.2, 101.8];
  section.raster_extent = [9.5, 11.5, 99, 103];
  section.window = { x_range: [10, 11], time_range: [100, 102] };
  const overlay = buildLayout(section, state({ wiggle: true }), 'zoom');
  assert.deepEqual(overlay.xaxis.range, [9.5, 11.5]);
  assert.deepEqual(overlay.yaxis.range, [102, 100]);
  const legacy = buildLayout(section, state(), 'zoom');
  assert.deepEqual(legacy.xaxis.range, [9.6, 11.4]);
  assert.deepEqual(legacy.yaxis.range, [101.8, 100.2]);
});
