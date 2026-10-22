/** CPU trace construction only; GPU/Plotly frame time is outside this benchmark.
 * node --expose-gc benchmarks/scene_geometry.mjs --baseline /path/to/sceneGeometry.ts
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const ts = require('typescript');
const baselineIndex = process.argv.indexOf('--baseline');
const baseline = baselineIndex >= 0 ? process.argv[baselineIndex + 1] : null;
if (baselineIndex >= 0 && !baseline) throw Error('--baseline needs a source file');
const asModule = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64');
const style = asModule(await readFile(new URL('../frontend/src/components/plotStyle.ts', import.meta.url), 'utf8'));
async function load(path) {
  const source = (await readFile(path, 'utf8')).replace('"../plotStyle"', JSON.stringify(style));
  return (await import(asModule(source))).buildTraces;
}
const current = await load(new URL('../frontend/src/components/SeismicViewer3D/sceneGeometry.ts', import.meta.url));
const previous = baseline ? await load(baseline) : null;
const colors = { seismic: [[0, '#23238e'], [.5, '#ffffff'], [1, '#8c0000']] };

function fixture(size, count = 1, cells = true, gaps = false) {
  const view = { seismic: { colormap: 'seismic', reverse_colormap: false, reverse_polarity: false },
    slices: { inline: [], crossline: [], time: [] }, horizons: [], scene: { show_bounding_box: false } };
  const slices = Array.from({ length: count }, (_, index) => {
    const kind = ['inline', 'crossline', 'time'][index % 3], id = `slice-${index}`;
    view.slices[kind].push({ id, visible: true, opacity: .8, border: { visible: false } });
    const a = Array.from({ length: size }, (_, c) => 30 + c);
    const b = Array.from({ length: size }, (_, r) => 200 + r);
    return { id, kind, position: 250, a, b,
      amplitude: b.map((_, r) => a.map((_, c) => gaps && (r + c) % 11 === 0 ? null : Math.sin(r * .03 + c * .07))),
      ...(cells ? { a_edges: Array.from({ length: size + 1 }, (_, c) => 29.5 + c),
        b_edges: Array.from({ length: size + 1 }, (_, r) => 199.5 + r) } : {}) };
  });
  return { data: { slices, horizons: {}, vmin: -1, vmax: 1,
    bounds: { x: [30, 900], y: [10, 600], z: [200, 1200] } }, view };
}

// Compare every actor field, including physical cells, nulls, colors and UIDs.
if (previous) for (const cells of [false, true]) for (const polarity of [false, true]) {
  const { data, view } = fixture(16, 3, cells, true);
  view.seismic.reverse_polarity = polarity;
  view.seismic.reverse_colormap = polarity;
  assert.deepStrictEqual(current(data, view, colors), previous(data, view, colors));
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function measure(build, data, view) {
  global.gc?.();
  const start = performance.now();
  const traces = build(data, view, colors);
  const ms = performance.now() - start;
  assert.equal(traces.length, data.slices.length);
  return ms;
}
const results = [];
for (const [size, count] of [[256, 1], [512, 1], [512, 3]]) {
  const { data, view } = fixture(size, count);
  const before = [], after = [];
  // Warm each implementation; alternate order to reduce drift from JIT/GC.
  measure(current, data, view);
  if (previous) measure(previous, data, view);
  for (let round = 0; round < 7; round++) {
    if (previous && round % 2 === 0) before.push(measure(previous, data, view));
    after.push(measure(current, data, view));
    if (previous && round % 2 !== 0) before.push(measure(previous, data, view));
  }
  results.push({ size, slices: count, removed_temporary_grid_values: 4 * size * size * count,
    before_ms: previous ? median(before) : null, after_ms: median(after),
    improvement_percent: previous ? 100 * (1 - median(after) / median(before)) : null,
    samples_before_ms: before, samples_after_ms: after });
}
process.stdout.write(JSON.stringify({ node: process.version, output_equality: previous ? true : null,
  measurement: 'CPU buildTraces median of 7; explicit GC when available; no GPU or browser claim', results }, null, 2) + '\n');
