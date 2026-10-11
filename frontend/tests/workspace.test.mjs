import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/workspace.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { initialMapWorkspace, initialExport3D, reconcileMapWorkspace, restoreState, readDraft } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

function defaults() {
  return {
    version: 1,
    view: { view_mode: '2d', seismic: { interpolation: 'bilinear', colormap: 'seismic' }, scene: { camera: { eye: { x: 1, y: 1, z: 1 } }, quality: 256 }, horizons: [] },
    map: initialMapWorkspace(), settings: { format: 'png', long_edge: 3000 }, settings3D: initialExport3D,
    dataset: '', selected: '', bytes: { il: 189, xl: 21 }, geometryMode: 'auto', sidebar: true, drag: 'zoom',
  };
}

test('restores camera, difference pair, zoom, profile endpoints and export settings', () => {
  const base = defaults();
  const saved = structuredClone(base);
  saved.view.view_mode = 'map';
  saved.view.scene.camera = { eye: { x: -2, y: 1, z: 0.7 }, projection: { type: 'orthographic' } };
  saved.view.horizons = [{ id: 'ref', name: 'Old name', color: '#123456', lighting: false }, { id: 'comp' }];
  saved.map.state = { ...saved.map.state, horizon: 'ref', color_by: 'difference', difference_reference: 'ref', difference_comparison: 'comp', difference_type: 'absolute', x_range: [20, 30] };
  saved.map.profileOn = true;
  saved.map.profileA = [10, 20];
  saved.map.profileB = [12, 30];
  saved.settings.format = 'pdf';
  saved.settings3D.format = 'svg';
  saved.selected = 'ref';
  const restored = restoreState(base, saved, [{ id: 'ref', name: 'Renamed', color: '#ffffff' }, { id: 'comp', name: 'Comparison' }]);
  assert.deepEqual(restored.view.scene.camera, saved.view.scene.camera);
  assert.deepEqual(restored.map, saved.map);
  assert.equal(restored.view.horizons[0].name, 'Renamed');
  assert.equal(restored.view.horizons[0].color, '#123456');
  assert.equal(restored.view.horizons[0].lighting, false);
  assert.equal(restored.settings.format, 'pdf');
  assert.equal(restored.settings3D.format, 'svg');
});

test('keeps new defaults and clears unavailable IDs without mutating saved state', () => {
  const base = defaults();
  const saved = structuredClone(base);
  saved.view.seismic = { colormap: 'petrel' };
  saved.map.state.horizon = 'missing';
  saved.map.state.difference_reference = 'missing';
  saved.map.state.difference_comparison = 'remaining';
  saved.selected = 'missing';
  const before = structuredClone(saved);
  const restored = restoreState(base, saved, [{ id: 'remaining', name: 'H1' }]);
  assert.equal(restored.view.seismic.interpolation, 'bilinear');
  assert.equal(restored.map.state.horizon, 'remaining');
  assert.equal(restored.map.state.difference_reference, null);
  assert.equal(restored.map.state.difference_comparison, 'remaining');
  assert.equal(restored.selected, 'remaining');
  assert.deepEqual(saved, before);
});

test('a quick-refresh draft only applies to its exact project and server revision', () => {
  const state = defaults();
  const storage = { getItem: () => JSON.stringify({ version: 1, project_id: 'project-1', revision: 4, state }) };
  assert.deepEqual(readDraft(storage, 'project-1', 4), state);
  assert.equal(readDraft(storage, 'project-2', 4), null);
  assert.equal(readDraft(storage, 'project-1', 5), null);
  assert.equal(readDraft({ getItem: () => '{broken' }, 'project-1', 4), null);
  assert.equal(readDraft({ getItem: () => { throw new Error('disabled'); } }, 'project-1', 4), null);
});

test('edits during an interrupted save recover only against its acknowledged body', () => {
  const inflight = defaults();
  const latest = structuredClone(inflight);
  latest.dataset = 'Newest edit';
  const storage = { getItem: () => JSON.stringify({ version: 1, project_id: 'project-1', revision: 4, state: latest, inflight }) };
  assert.deepEqual(readDraft(storage, 'project-1', 5, inflight), latest);
  assert.equal(readDraft(storage, 'project-1', 6, inflight), null);
  const otherTab = structuredClone(inflight);
  otherTab.dataset = 'Other tab';
  assert.equal(readDraft(storage, 'project-1', 5, otherTab), null);
});

test('deleting a comparison clears its reference without silently choosing another horizon', () => {
  const map = initialMapWorkspace();
  map.state = { ...map.state, horizon: 'grid', color_by: 'difference', difference_reference: 'ref', difference_comparison: 'comp', range_mode: 'manual', vmin: -8, vmax: 8, x_range: [1, 5] };
  const before = structuredClone(map);
  const result = reconcileMapWorkspace(map, [{ id: 'grid' }, { id: 'ref' }, { id: 'other' }]);
  assert.equal(result.state.color_by, 'difference');
  assert.equal(result.state.difference_reference, 'ref');
  assert.equal(result.state.difference_comparison, null);
  assert.equal(result.state.range_mode, 'auto');
  assert.equal(result.state.x_range, null);
  assert.deepEqual(map, before);
});

test('removing an output grid keeps an intact comparison and handles an empty workspace', () => {
  const map = initialMapWorkspace();
  map.state = { ...map.state, horizon: 'grid', color_by: 'difference', difference_reference: 'ref', difference_comparison: 'comp' };
  const result = reconcileMapWorkspace(map, [{ id: 'ref' }, { id: 'comp' }]);
  assert.equal(result.state.horizon, 'ref');
  assert.equal(result.state.difference_reference, 'ref');
  assert.equal(result.state.difference_comparison, 'comp');
  assert.equal(reconcileMapWorkspace(result, [{ id: 'ref' }, { id: 'comp' }]), result);
  const empty = reconcileMapWorkspace(result, []);
  assert.equal(empty.state.horizon, '');
  assert.equal(empty.state.difference_reference, null);
  assert.equal(empty.state.difference_comparison, null);
});
