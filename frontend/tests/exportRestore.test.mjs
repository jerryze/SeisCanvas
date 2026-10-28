import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const load = async path => {
  const code = ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
};
const { restoreFigure } = await load('../src/exportRestore.ts');
const { initialMapWorkspace, initialExport3D, restoreState } = await load('../src/workspace.ts');
const meta = { inlines: [10, 12], crosslines: [30, 33, 38], time_range: [200, 212] };
const base = () => ({ version: 1, dataset: 'Keep project label', selected: 'h', bytes: { il: 189, xl: 21 }, geometryMode: 'auto',
  view: { view_mode: '2d', view_type: 'inline', section_number: 10, seismic: { colormap: 'seismic' }, scene: { camera: { eye: { x: 1, y: 2, z: 3 } } },
    horizons: [{ id: 'h', name: 'Current name', color: '#111111', visible: true, opacity: .3 }, { id: 'new', name: 'Added later', visible: true }] },
  map: initialMapWorkspace(), settings: { format: 'png', width: 180, height: 100 }, settings3D: initialExport3D });
const snapshot2d = () => ({ version: 1, kind: '2d', warnings: [], request: { state: { view_type: 'crossline', section_number: 33, x_range: [10, 12], time_range: [202, 210], aspect_ratio_2d: [3, 1], seismic: { colormap: 'seismic', variable_area: true, wiggle_gain: 2 }, horizons: [{ id: 'h', name: 'Old name', color: '#abcdef', visible: true }] }, settings: { format: 'svg', font_size: 13 } } });

test('2D restores exported range and styles, retains current names and hides added layers without mutating inputs', () => {
  const current = base(), snapshot = snapshot2d(), before = structuredClone([current, snapshot]);
  const next = restoreFigure(current, snapshot, meta);
  assert.equal(next.view.section_number, 33);
  assert.equal(next.view.horizons[0].name, 'Current name');
  assert.equal(next.view.horizons[0].color, '#abcdef');
  assert.equal(next.view.horizons[0].opacity, .3);
  assert.equal(next.view.horizons[1].visible, false);
  assert.deepEqual(next.view.time_range, [202, 210]);
  assert.equal(next.view.seismic.variable_area, true);
  assert.equal(next.settings.format, 'svg');
  assert.equal(next.dataset, current.dataset);
  assert.deepEqual([current, snapshot], before);
  const reloaded = restoreState(base(), next, current.view.horizons);
  assert.deepEqual(reloaded.view, next.view);
  assert.deepEqual(reloaded.settings, next.settings);
});

test('3D restores camera and slice positions, leaving the 2D section untouched', () => {
  const state = { seismic: { colormap: 'seismic' }, horizons: [], slices: { inline: [{ position: 12 }], crossline: [], time: [{ position: 208 }] }, scene: { camera: { eye: { x: -2, y: 1, z: 1 } }, quality: 512 } };
  const snapshot = { version: 1, kind: '3d', warnings: [], request: { state, settings: { format: 'pdf', long_edge: 1800 } } };
  const next = restoreFigure(base(), snapshot, meta);
  assert.equal(next.view.view_mode, '3d');
  assert.equal(next.view.section_number, 10);
  assert.deepEqual(next.view.scene.camera, state.scene.camera);
  assert.deepEqual(next.view.slices, state.slices);
  assert.equal(next.settings3D.long_edge, 1800);
  state.slices.inline[0].position = 11;
  assert.throws(() => restoreFigure(base(), snapshot, meta), /切片位置/);
});

test('map restores difference pair, automatic contour spacing and A–B overlay', () => {
  const current = base();
  const state = { ...current.map.state, horizon: 'h', color_by: 'difference', difference_reference: 'h', difference_comparison: 'new', interval: null };
  const snapshot = { version: 1, kind: 'map', warnings: [], request: { state, settings: { format: 'pdf' }, profile: { a: [10, 30], b: [12, 33] } } };
  const next = restoreFigure(current, snapshot, meta);
  assert.equal(next.map.activeView, 'map');
  assert.equal(next.map.state.interval_auto, true);
  assert.equal(next.map.state.difference_comparison, 'new');
  assert.deepEqual(next.map.profileA, [10, 30]);
  assert.equal(next.map.settings.show_ab, true);
  assert.equal(next.map.profileOn, true);
  snapshot.request.profile = null;
  const plain = restoreFigure(next, snapshot, meta);
  assert.equal(plain.map.profileOn, false);
  assert.equal(plain.map.profileA, null);
  snapshot.request.state.difference_comparison = 'missing';
  assert.throws(() => restoreFigure(current, snapshot, meta), /所需层位/);
});

test('A–B restores endpoints, waveform, layers, range, aspect and furniture independently of 2D', () => {
  const current = base(); current.view.aspect_ratio_2d = [2, 1];
  const snapshot = { version: 1, kind: 'profile', warnings: [], request: { state: { ...current.map.state, horizon: 'h', interval: 4 }, settings: { format: 'svg' },
    a: [10, 30], b: [12, 38], seismic: { colormap: 'seismic', wiggle: true }, horizons: current.view.horizons,
    x_range: [0, 4], time_range: [202, 210], aspect_ratio_2d: [3, 1], show_curves: false, show_ab: false, show_legend: true } };
  const next = restoreFigure(current, snapshot, meta);
  assert.equal(next.map.activeView, 'section');
  assert.equal(next.map.profileAspectRatio, 3);
  assert.deepEqual(next.view.aspect_ratio_2d, [2, 1]);
  assert.deepEqual(next.map.profileXRange, [0, 4]);
  assert.equal(next.map.profileSettings.show_curves, false);
  assert.equal(next.map.profileSettings.show_ab, false);
  assert.equal(next.view.seismic.wiggle, true);
  assert.deepEqual(restoreState(base(), next, current.view.horizons).map, next.map);
  snapshot.request.b = [12, 99];
  assert.throws(() => restoreFigure(current, snapshot, meta), /端点超出/);
});

test('missing layers, unsupported versions and invalid sections fail atomically', () => {
  const current = base(), before = structuredClone(current);
  for (const mutate of [s => s.version = 9, s => s.request.state.section_number = 99,
    s => s.request.state.horizons[0].id = 'gone', s => s.request.state.time_range = [NaN, 210],
    s => s.request.state.x_range = [80, 90]]) {
    const snapshot = snapshot2d(); mutate(snapshot);
    assert.throws(() => restoreFigure(current, snapshot, meta));
    assert.deepEqual(current, before);
  }
});


test('restoring a figure retains model identities and unifies later corresponding layers', () => {
  const current = base(), snapshot = snapshot2d();
  Object.assign(current.view.horizons[0], { model_group: 'Renamed group', horizon_key: 'T30' });
  Object.assign(current.view.horizons[1], { model_group: 'New model', horizon_key: 'T24', color: '#ff0000' });
  Object.assign(snapshot.request.state.horizons[0], { model_group: 'DTW', horizon_key: 'T24' });
  const next = restoreFigure(current, snapshot, meta);
  assert.equal(next.view.horizons[0].model_group, 'DTW');
  assert.equal(next.view.horizons[0].horizon_key, 'T24');
  assert.equal(next.view.horizons[1].model_group, 'New model');
  assert.equal(next.view.horizons[1].color, '#abcdef');
  assert.equal(next.view.horizons[1].visible, false);
  assert.deepEqual(restoreState(base(), next, current.view.horizons).view.horizons, next.view.horizons);
});

test('horizon-only projects restore time and difference maps without inventing seismic bounds', () => {
  const current = base();
  for (const color_by of ['twt', 'difference']) {
    const state = { ...current.map.state, horizon: 'h', color_by, difference_reference: 'h', difference_comparison: 'new', interval: null,
      x_range: [1000, 2000], y_range: [3000, 4000] };
    const snapshot = { version: 1, kind: 'map', warnings: [], request: { state, settings: { format: 'svg' }, profile: null } };
    const before = structuredClone([current, snapshot]);
    const next = restoreFigure(current, snapshot, null);
    assert.equal(next.view.view_mode, 'map');
    assert.equal(next.map.activeView, 'map');
    assert.equal(next.map.state.color_by, color_by);
    assert.deepEqual(next.map.state.x_range, [1000, 2000]);
    assert.equal(next.map.settings.format, 'svg');
    assert.equal(next.map.profileOn, false);
    assert.equal(next.map.state.interval_auto, true);
    assert.deepEqual([current, snapshot], before);
    snapshot.request.state.x_range = [NaN, 2000];
    assert.throws(() => restoreFigure(current, snapshot, null), /图件范围/);
    snapshot.request.state.x_range = [2000, 1000];
    assert.throws(() => restoreFigure(current, snapshot, null), /图件范围/);
    snapshot.request.state.x_range = null;
    snapshot.request.state.horizon = 'removed';
    assert.throws(() => restoreFigure(current, snapshot, null), /所需层位/);
  }
});

test('horizon geometry restores all layer views while amplitude still requires seismic', () => {
  const current = base(), before = structuredClone(current);
  const section = restoreFigure(current, snapshot2d(), meta, false);
  assert.equal(section.view.section_number, 33);
  assert.equal(section.view.view_mode, '2d');
  const scene = { version: 1, kind: '3d', warnings: [], request: { state: {
    horizons: [{ ...current.view.horizons[0], display_mode: 'full_surface', color_by: 'twt' }],
    slices: { inline: [{ position: 12 }], crossline: [], time: [{ position: 208 }] }, scene: current.view.scene,
  }, settings: { format: 'png' } } };
  assert.equal(restoreFigure(current, scene, meta, false).view.view_mode, '3d');
  const map = { version: 1, kind: 'map', warnings: [], request: {
    state: { ...current.map.state, horizon: 'h', interval: null }, settings: {}, profile: { a: [10, 30], b: [12, 33] },
  } };
  assert.equal(restoreFigure(current, map, meta, false).map.profileOn, true);
  const profile = { version: 1, kind: 'profile', warnings: [], request: {
    state: map.request.state, settings: {}, a: [10, 30], b: [12, 33], horizons: current.view.horizons,
    x_range: null, time_range: [202, 210], aspect_ratio_2d: null,
  } };
  assert.equal(restoreFigure(current, profile, meta, false).map.activeView, 'section');
  scene.request.state.horizons[0].color_by = 'amplitude';
  map.request.state.color_by = 'amplitude';
  for (const snapshot of [scene, map]) {
    assert.throws(() => restoreFigure(current, snapshot, meta, false), /振幅着色需要先导入 SEG-Y/);
    assert.deepEqual(current, before);
  }
  assert.throws(() => restoreFigure(current, snapshot2d(), null, false), /先导入层位或 SEG-Y/);
});

test('attaching a smaller survey does not invalidate saved horizon map extents', () => {
  const current = base();
  for (const color_by of ['twt', 'difference']) {
    const snapshot = { version: 1, kind: 'map', warnings: [], request: {
      state: { ...current.map.state, horizon: 'h', color_by, difference_reference: 'h', difference_comparison: 'new', interval: null,
        x_range: [1000, 2000], y_range: [3000, 4000] }, settings: { format: 'svg' }, profile: null,
    } };
    assert.deepEqual(restoreFigure(current, snapshot, meta), restoreFigure(current, snapshot, null));
    snapshot.request.state.x_range = [2000, 1000];
    assert.throws(() => restoreFigure(current, snapshot, meta), /图件范围/);
  }
  const amplitude = { version: 1, kind: 'map', warnings: [], request: {
    state: { ...current.map.state, horizon: 'h', color_by: 'amplitude', interval: null, x_range: [1000, 2000] }, settings: {}, profile: null,
  } };
  assert.throws(() => restoreFigure(current, amplitude, meta), /图件范围/);
  amplitude.request.state.color_by = 'twt';
  amplitude.request.profile = { a: [10, 30], b: [12, 33] };
  assert.throws(() => restoreFigure(current, amplitude, meta), /图件范围/);
});
