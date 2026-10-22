import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/components/SeismicViewer3D/sceneCamera.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { sceneCameraKey } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const preset = { eye: { x: 1.25, y: 1.25, z: .9 }, up: { x: 0, y: 0, z: 1 }, center: { x: 0, y: 0, z: 0 } };

test('renderer camera readback preserves identity across field order and floating-point roundoff', () => {
  const live = { up: { z: 1, y: 0, x: 0 }, center: { z: 0, x: 0, y: 0 }, eye: { z: .900000000000001, y: 1.25, x: 1.250000000000002 }, projection: { type: 'perspective' } };
  assert.equal(sceneCameraKey(preset), sceneCameraKey(live));
});

test('real orbit, zoom, pan and projection changes remain distinguishable', () => {
  const original = sceneCameraKey(preset);
  for (const patch of [ { eye: { x: 1.25, y: 1.25, z: 1.2 } }, { eye: { x: 1, y: 1, z: .72 } }, { center: { x: .1, y: .2, z: 0 } }, { projection: { type: 'orthographic' } } ]) {
    assert.notEqual(sceneCameraKey({ ...preset, ...patch }), original);
  }
});
