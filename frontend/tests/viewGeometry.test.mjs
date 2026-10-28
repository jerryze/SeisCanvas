import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/viewGeometry.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { geometryTimeCenter, geometryPositions, snapGeometryPosition, reconcileViewGeometry } =
  await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const geometry = { inlines: [10, 12, 14], crosslines: [30, 40], time_range: [100.25, 250.75], samples: 0, sample_interval: 0 };

test('horizon geometry uses actual pick bounds and permits continuous time slices', () => {
  assert.equal(geometryTimeCenter(geometry), 175.5);
  assert.deepEqual(geometryPositions(geometry, 'time'), [100.25, 250.75]);
  assert.equal(snapGeometryPosition(geometry, 'time', 181.125), 181.125);
  assert.equal(snapGeometryPosition(geometry, 'time', 50), 100.25);
  assert.equal(snapGeometryPosition(geometry, 'time', 999), 250.75);
  assert.equal(snapGeometryPosition(geometry, 'inline', 11.8), 12);
  assert.equal(snapGeometryPosition(geometry, 'crossline', 31), 30);
});

test('seismic sampling still selects exact original sample positions', () => {
  const seismic = { ...geometry, time_range: [200, 212], samples: 4, sample_interval: 4 };
  assert.equal(geometryTimeCenter(seismic), 208);
  assert.deepEqual(geometryPositions(seismic, 'time'), [200, 204, 208, 212]);
  assert.equal(snapGeometryPosition(seismic, 'time', 205.25), 204);
});

test('changing horizon extents repairs view coordinates without losing camera, styles or hidden slices', () => {
  const view = { view_mode: '3d', view_type: 'inline', section_number: 350,
    x_range: [100, 120], time_range: [400, 500], scene: { camera: { eye: { x: 1, y: 2, z: 3 } } },
    slices: { inline: [{ id: 'a', position: 350, visible: false }], crossline: [], time: [{ id: 'b', position: 190.125, visible: true }] },
    horizons: [{ id: 'h', color_by: 'amplitude', color: '#123456', visible: false }],
  };
  const before = structuredClone(view), next = reconcileViewGeometry(view, geometry, false);
  assert.equal(next.view_mode, '3d');
  assert.equal(next.section_number, 14);
  assert.equal(next.slices.inline[0].position, 14);
  assert.equal(next.slices.inline[0].visible, false);
  assert.equal(next.slices.time[0].position, 190.125);
  assert.equal(next.x_range, null);
  assert.equal(next.time_range, null);
  assert.equal(next.scene, view.scene);
  assert.deepEqual(next.horizons[0], { ...view.horizons[0], color_by: 'twt' });
  assert.deepEqual(view, before);
  assert.equal(reconcileViewGeometry(view, geometry, true).horizons, view.horizons);
});
