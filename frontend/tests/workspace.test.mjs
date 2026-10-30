import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/workspace.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { initialMapWorkspace, initialExport3D, reconcileMapWorkspace, restoreState, readDraft, draftKey, projectDrafts, removeProjectDrafts, DRAFT_KEY } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

function defaults() {
  return {
    version: 1,
    view: { view_mode: '2d', seismic: { interpolation: 'bilinear', colormap: 'seismic', wiggle: false, variable_area: false, wiggle_gain: 1, variable_area_color: '#000000', background_interpolation: true, wiggle_interpolation: true }, scene: { camera: { eye: { x: 1, y: 1, z: 1 } }, quality: 256 }, horizons: [] },
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
  saved.map.activeView = 'section';
  saved.map.profileDrag = 'pan';
  saved.map.profileXRange = [0, 15];
  saved.map.profileTimeRange = [220, 400];
  saved.map.profileAspectRatio = 3;
  saved.map.profileSettings.long_edge = 1800;
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

test('upgrades split-pane state to the map tab while removing obsolete height state', () => {
  const base = defaults(), saved = structuredClone(base);
  delete saved.map.activeView;
  delete saved.map.profileDrag;
  delete saved.map.profileAspectRatio;
  saved.map.profileShare = 70;
  saved.map.profileOn = true;
  saved.map.profileA = [10, 30];
  saved.map.profileB = [12, 38];
  saved.map.profileXRange = [0, 8];
  saved.map.profileTimeRange = [200, 212];
  const before = structuredClone(saved);
  const restored = restoreState(base, saved, []);
  assert.equal(restored.map.activeView, 'map');
  assert.equal(restored.map.profileDrag, 'zoom');
  assert.equal(restored.map.profileAspectRatio, null);
  assert.equal('profileShare' in restored.map, false);
  for (const field of ['profileOn', 'profileA', 'profileB', 'profileXRange', 'profileTimeRange', 'profileSettings'])
    assert.deepEqual(restored.map[field], saved.map[field]);
  assert.deepEqual(saved, before);
});

test('A–B aspect is independent of the 2D aspect and rejects invalid persisted ratios', () => {
  const base = defaults(), saved = structuredClone(base);
  saved.view.aspect_ratio_2d = [2, 1];
  for (const ratio of [.02, 1, 3, 50, null, NaN, Infinity, 0, -1, 100, '2']) {
    saved.map.profileAspectRatio = ratio;
    const restored = restoreState(base, saved, []);
    const expected = typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= .02 && ratio <= 50 ? ratio : null;
    assert.equal(restored.map.profileAspectRatio, expected);
    assert.deepEqual(restored.view.aspect_ratio_2d, [2, 1]);
  }
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
  assert.equal(restored.view.seismic.wiggle, false);
  assert.equal(restored.view.seismic.variable_area, false);
  assert.equal(restored.view.seismic.wiggle_gain, 1);
  assert.equal(restored.view.seismic.variable_area_color, '#000000');
  assert.equal(restored.view.seismic.background_interpolation, true);
  assert.equal(restored.view.seismic.wiggle_interpolation, true);
  assert.equal(restored.map.state.horizon, 'remaining');
  assert.equal(restored.map.state.difference_reference, null);
  assert.equal(restored.map.state.difference_comparison, 'remaining');
  assert.equal(restored.selected, 'remaining');
  assert.deepEqual(saved, before);
});

test('restores independent waveform, area and interpolation settings with the existing seismic state', () => {
  const base = defaults();
  const saved = structuredClone(base);
  saved.view.seismic = { colormap: 'petrel', wiggle: false, variable_area: true, wiggle_gain: 2.5, variable_area_color: '#123456' };
  for (const [background_interpolation, wiggle_interpolation] of [[false, true], [true, false], [false, false]]) {
    Object.assign(saved.view.seismic, { background_interpolation, wiggle_interpolation });
    const restored = restoreState(base, saved, []);
    assert.deepEqual(restored.view.seismic, { ...base.view.seismic, ...saved.view.seismic });
  }
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

test('restores the shared horizon smoothing preference independently of horizon selection', () => {
  const base = defaults();
  base.view.smooth_horizons = false;
  const saved = structuredClone(base);
  saved.view.smooth_horizons = true;
  saved.view.horizon_sg = true;
  saved.view.horizon_sg_window = 11;
  saved.selected = 'old';
  const restored = restoreState(base, saved, [{ id: 'new', name: 'New horizon' }]);
  assert.equal(restored.view.smooth_horizons, true);
  assert.equal(restored.view.horizon_sg, true);
  assert.equal(restored.view.horizon_sg_window, 11);
  assert.equal(restored.selected, 'new');
  delete saved.view.smooth_horizons;
  assert.equal(restoreState(base, saved, []).view.smooth_horizons, false);
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


test('project/tab draft keys isolate simultaneous work and enumerate restart candidates', () => {
  const state = defaults();
  const values = new Map([
    [draftKey('a', 'tab-1'), JSON.stringify({ version: 1, project_id: 'a', revision: 3, state })],
    [draftKey('a', 'tab-2'), JSON.stringify({ version: 1, project_id: 'a', revision: 2, state: { ...state, dataset: 'older' } })],
    [draftKey('b', 'tab-1'), JSON.stringify({ version: 1, project_id: 'b', revision: 3, state: { ...state, dataset: 'other project' } })],
  ]);
  const storage = { getItem: key => values.get(key) || null, key: i => [...values.keys()][i], length: values.size };
  assert.deepEqual(readDraft(storage, 'a', 3, null, 'tab-1'), state);
  assert.equal(readDraft(storage, 'a', 3, null, 'tab-2'), null);
  const candidates = projectDrafts(storage, 'a', 3, null);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map(c => c.compatible), [true, false]);
  assert.ok(candidates.every(c => c.project_id === 'a'));
});

test('draft enumeration omits committed bodies and recognises interrupted acknowledgements', () => {
  const state = defaults();
  const later = { ...state, dataset: 'later edits' };
  const values = new Map([
    [draftKey('a', 'saved'), JSON.stringify({ version: 1, project_id: 'a', revision: 5, state })],
    [draftKey('a', 'interrupted'), JSON.stringify({ version: 1, project_id: 'a', revision: 4, state: later, inflight: state })],
  ]);
  const storage = { getItem: key => values.get(key) || null, key: i => [...values.keys()][i], length: values.size };
  const candidates = projectDrafts(storage, 'a', 5, state);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].compatible, true);
  assert.deepEqual(candidates[0].state, later);
});

test('permanent deletion removes only the selected project drafts across tabs', () => {
  const values = new Map([
    [draftKey('a', 'tab-1'), 'first'], [draftKey('a', 'tab-2'), 'second'],
    [draftKey('ab', 'tab-1'), 'another project'], ['preferences', 'keep'],
    [DRAFT_KEY, JSON.stringify({ project_id: 'a' })],
  ]);
  const storage = { getItem: key => values.get(key) || null, key: i => [...values.keys()][i], get length() { return values.size; }, removeItem: key => values.delete(key) };
  removeProjectDrafts(storage, 'a');
  assert.deepEqual([...values.entries()], [[draftKey('ab', 'tab-1'), 'another project'], ['preferences', 'keep']]);
  values.set(DRAFT_KEY, JSON.stringify({ project_id: 'b' }));
  removeProjectDrafts(storage, 'a');
  assert.equal(JSON.parse(values.get(DRAFT_KEY)).project_id, 'b');
});
