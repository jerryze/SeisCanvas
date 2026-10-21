import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/components/loadedRaster.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { coversViewport, layoutPatch } = await import('data:text/javascript;base64,' + Buffer.from(output).toString('base64'));
const loaded = { raster_extent: [0, 1000, 200, 1200], preview_shape: [1000, 1000] };

test('a loaded raster serves different windows when coverage and pixel density suffice', () => {
  assert.equal(coversViewport(loaded, [200, 600], [400, 800], 400, 400, true, false), true);
  assert.equal(coversViewport(loaded, [400, 800], [600, 1000], 400, 400, true, false), true);
  assert.equal(coversViewport(loaded, [400, 800], [1000, 600], 400, 400, true, false), true);
});
test('overlapping or sharper views still request data', () => {
  assert.equal(coversViewport(loaded, [900, 1100], [400, 800], 400, 400, true, false), false);
  assert.equal(coversViewport(loaded, [200, 400], [400, 600], 400, 400, true, false), false);
  assert.equal(coversViewport(loaded, [200, 600], [100, 500], 400, 400, true, false), false);
});
test('backend pixel budget is respected without repeatedly requesting impossible detail', () => {
  const capped = { raster_extent: [0, 1000, 200, 1200], preview_shape: [774, 774] };
  assert.equal(coversViewport(capped, [0, 1000], [200, 1200], 2000, 2000, true, false), true);
});
test('native sample cells stay reusable while adaptive waveform geometry is refreshed', () => {
  const native = { raster_extent: [0, 1000, 200, 1200] };
  assert.equal(coversViewport(native, [201, 202], [401, 402], 1000, 1000, false, false), true);
  assert.equal(coversViewport(loaded, [0, 1000], [200, 1200], 400, 400, true, true), false);
});
test('invalid or unmeasured windows cannot suppress a necessary request', () => {
  assert.equal(coversViewport(loaded, [0, 0], [200, 1200], 400, 400, true, false), false);
  assert.equal(coversViewport(loaded, [0, 1000], [200, 1200], 0, 400, true, false), false);
  assert.equal(coversViewport({}, [0, 1000], [200, 1200], 400, 400, true, false), false);
});
test('committing the already visible axes produces no redundant Plotly update', () => {
  const layout = { xaxis: { range: [10, 20] }, yaxis: { range: [600, 200] }, dragmode: 'pan' };
  assert.deepEqual(layoutPatch(layout, { 'xaxis.range': [10, 20], 'yaxis.range': [600, 200], dragmode: 'pan' }), {});
  assert.deepEqual(layoutPatch(layout, { 'xaxis.range': [12, 22], dragmode: 'zoom' }), { 'xaxis.range': [12, 22], dragmode: 'zoom' });
  assert.deepEqual(layoutPatch(layout, { 'xaxis.range': [10 + 1e-12, 20] }), {});
  const range = [12, 22];
  const patch = layoutPatch(layout, { 'xaxis.range': range });
  patch['xaxis.range'][0] = 999;
  assert.deepEqual(range, [12, 22], 'Plotly must not mutate the workspace or cached range');
});
