import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/components/SeismicViewer3D/sliceSampling.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { advanceSliceSampling } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

function observation(overrides = {}) {
  return {
    camera: { eye: { x: 0, y: 0, z: 2 }, center: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 }, projection: { type: 'perspective' } },
    width: 1000, height: 800, viewports: { il: [512, 640] },
    ...overrides,
  };
}
const start = overrides => advanceSliceSampling(null, observation(overrides));

test('orbit and pan preserve sampling allocations regardless of projected plane sizes', () => {
  const initial = start();
  const orbit = observation();
  orbit.camera.eye = { x: 2, y: 0, z: 0 };
  orbit.viewports = { il: [2048, 160] };
  assert.equal(advanceSliceSampling(initial, orbit), initial);
  const pan = observation();
  pan.camera.eye = { x: 9, y: -4, z: 7 };
  pan.camera.center = { x: 9, y: -4, z: 5 };
  pan.viewports = { il: [16000, 16000] };
  assert.equal(advanceSliceSampling(initial, pan), initial);
});

test('small wheel steps accumulate and only significant zoom upgrades sampling', () => {
  const initial = start();
  const slight = observation({ viewports: { il: [576, 736] } });
  slight.camera.eye.z = 2 / 1.1;
  assert.equal(advanceSliceSampling(initial, slight), initial);
  const zoomed = observation({ viewports: { il: [768, 960] } });
  zoomed.camera.eye.z = 2 / 1.5;
  const next = advanceSliceSampling(initial, zoomed);
  assert.deepEqual(next.viewports, zoomed.viewports);
  assert.equal(advanceSliceSampling(next, zoomed), next);
});

test('ordinary textures retain loaded resolution on zoom out and container shrink', () => {
  const initial = start();
  const smaller = observation({ width: 500, height: 400, viewports: { il: [128, 160] } });
  smaller.camera.eye.z = 4;
  assert.equal(advanceSliceSampling(initial, smaller), initial);
  // Returning from a zoom out does not count as demand growth over loaded data.
  assert.equal(advanceSliceSampling(initial, observation()), initial);
});

test('container growth can upgrade existing sampling and retains unaffected dimensions', () => {
  const initial = start();
  const larger = observation({ width: 1500, viewports: { il: [768, 608] } });
  assert.deepEqual(advanceSliceSampling(initial, larger).viewports, { il: [768, 640] });
  assert.equal(advanceSliceSampling(initial,
    observation({ width: 1010, height: 801, viewports: { il: [544, 672] } })), initial);
});

test('orthographic wheel aspect scaling upgrades sampling without changing camera distance', () => {
  const ortho = observation();
  ortho.camera.projection.type = 'orthographic';
  const initial = advanceSliceSampling(null, ortho);
  const zoom = { ...ortho, aspectRatio: { x: 1.5, y: 1.5, z: 1.5 }, viewports: { il: [768, 960] } };
  assert.deepEqual(advanceSliceSampling(initial, zoom).viewports, zoom.viewports);
});

test('projection presets retain resolution and establish a new zoom baseline', () => {
  const initial = start();
  const preset = observation({ viewports: { il: [2048, 2048] } });
  preset.camera.projection.type = 'orthographic';
  preset.camera.eye = { x: 0, y: 0, z: 1 };
  const next = advanceSliceSampling(initial, preset);
  assert.equal(next.viewports, initial.viewports);
  assert.equal(advanceSliceSampling(next, preset), next);
});

test('waveform overlays resample after zooming out so native trace spacing can adapt', () => {
  const initial = start({ traceOverlays: true });
  const smaller = observation({ traceOverlays: true, viewports: { il: [256, 320] } });
  smaller.camera.eye.z = 4;
  const next = advanceSliceSampling(initial, smaller);
  assert.deepEqual(next.viewports, smaller.viewports);
  assert.equal(advanceSliceSampling(next, smaller), next);
  const orbit = { ...smaller, viewports: { il: [64, 128] },
    camera: { ...smaller.camera, eye: { x: 4, y: 0, z: 0 } } };
  assert.equal(advanceSliceSampling(next, orbit), next);
});

test('new visible slices initialize independently and old IDs are discarded', () => {
  const initial = start();
  const next = advanceSliceSampling(initial, observation({
    sliceIds: ['xl'], viewports: { xl: [400, 500] },
  }));
  assert.deepEqual(next.viewports, { xl: [416, 512] });
  const empty = advanceSliceSampling(next, observation({ sliceIds: [], viewports: {} }));
  assert.deepEqual(empty.viewports, {});
});

test('invalid or temporarily unavailable measurements keep valid allocations', () => {
  const initial = start();
  assert.equal(advanceSliceSampling(initial, observation({ viewports: {} })), initial);
  assert.equal(advanceSliceSampling(initial, observation({
    width: 0, height: NaN, viewports: { il: [NaN, Infinity] },
  })), initial);
  const next = advanceSliceSampling(initial, observation({ viewports: { added: [1, 1e6] } }));
  assert.deepEqual(next.viewports.added, [32, 16000]);
});

test('sampling leaves measurements, camera, source coordinates, and previous state untouched', () => {
  const initial = start();
  const measured = observation({ viewports: { il: [768, 960] } });
  measured.camera.eye.z = 1;
  measured.source_a_range = [101.25, 901.75];
  measured.source_b_range = [0, 2400];
  const input = structuredClone(measured);
  const before = structuredClone(initial);
  advanceSliceSampling(initial, measured);
  assert.deepEqual(initial, before);
  assert.deepEqual(measured, input);
});
