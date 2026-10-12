import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/components/horizonMapLogic.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { mapPresentation, mapSelectionError, profileEndpointError, profileRequestKey } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const horizons = [{ id: 'r', name: '参考' }, { id: 'c', name: '对比' }];

test('difference direction, absolute bars and units stay consistent with the calculated scalar', () => {
  const state = { horizon: 'r', color_by: 'difference', difference_reference: 'r', difference_comparison: 'c', difference_type: 'signed' };
  assert.deepEqual(mapPresentation(state, horizons), { title: '层位差值 · 对比 − 参考', scalar: 'ΔTime', unit: 'ms' });
  assert.deepEqual(mapPresentation({ ...state, difference_type: 'absolute' }, horizons), { title: '层位差值 · |对比 − 参考|', scalar: '|ΔTime|', unit: 'ms' });
  assert.match(mapPresentation({ ...state, difference_comparison: null }, horizons).title, /请选择对比层位/);
});

test('amplitude readings do not inherit time units', () => {
  assert.deepEqual(mapPresentation({ horizon: 'r', color_by: 'amplitude' }, horizons), { title: '沿层振幅 · 参考', scalar: '振幅', unit: '' });
  assert.equal(mapPresentation({ horizon: 'r', color_by: 'twt' }, horizons).unit, 'ms');
});

test('incomplete picking, coincident endpoints and invalid coordinates are distinguished', () => {
  assert.equal(profileEndpointError(null, [1, 2]), '');
  assert.match(profileEndpointError([1, 2], [1, 2]), /不能重合/);
  assert.match(profileEndpointError([NaN, 2], [1, 3]), /有效数字/);
  assert.equal(profileEndpointError([1, 2], [1, 3]), '');
});

test('missing and identical comparison members cannot render a misleading result', () => {
  const state = { horizon: 'r', color_by: 'difference', difference_reference: 'r', difference_comparison: 'c' };
  assert.equal(mapSelectionError(state, horizons), '');
  assert.match(mapSelectionError({ ...state, difference_reference: null }, horizons), /请选择已加载/);
  assert.match(mapSelectionError({ ...state, difference_comparison: 'r' }, horizons), /不能相同/);
  assert.match(mapSelectionError(state, [horizons[0]]), /需要两个不同层位/);
  assert.match(mapSelectionError(state, []), /导入或选择/);
});

test('map color and display edits preserve the current A–B raster', () => {
  const state = { horizon: 'r', color_by: 'twt', colormap: 'petrel', colorbar: true };
  const seismic = { adaptive_resolution: true, interpolation: 'bilinear', colormap: 'seismic', reverse_colormap: false };
  const key = profileRequestKey(state, 'loaded-horizons', [1, 2], [3, 4], seismic);
  for (const color_by of ['twt', 'amplitude', 'difference']) {
    assert.equal(profileRequestKey({ ...state, color_by, colormap: 'viridis', colorbar: false }, 'loaded-horizons', [1, 2], [3, 4], { ...seismic, colormap: 'gray', reverse_colormap: true }), key);
  }
});

test('geometry and sampling edits invalidate the A–B raster', () => {
  const state = { horizon: 'r' };
  const seismic = { adaptive_resolution: true, interpolation: 'bilinear' };
  const key = profileRequestKey(state, 'loaded-horizons', [1, 2], [3, 4], seismic);
  assert.notEqual(profileRequestKey({ horizon: 'c' }, 'loaded-horizons', [1, 2], [3, 4], seismic), key);
  assert.notEqual(profileRequestKey(state, 'changed-horizons', [1, 2], [3, 4], seismic), key);
  assert.notEqual(profileRequestKey(state, 'loaded-horizons', [2, 2], [3, 4], seismic), key);
  assert.notEqual(profileRequestKey(state, 'loaded-horizons', [1, 2], [3, 5], seismic), key);
  assert.notEqual(profileRequestKey(state, 'loaded-horizons', [1, 2], [3, 4], { ...seismic, interpolation: 'bicubic' }), key);
  assert.notEqual(profileRequestKey(state, 'loaded-horizons', [1, 2], [3, 4], { ...seismic, adaptive_resolution: false }), key);
});
