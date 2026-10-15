import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/components/SeismicViewer2D/horizonCurve.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { horizonCurve } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const points = [[0, 100.125], [1.2, 102.75], [3.7, 101.375], [5, 101.375], [9, 105.625]];

test('nonuniform PCHIP matches independently computed SciPy values and every fractional knot', () => {
  const before = structuredClone(points);
  const curve = horizonCurve(points, { width: 18, xRange: [0, 9] });
  // Independent scipy.interpolate.PchipInterpolator reference values.
  const expected = [[0.5, 101.63564775713213], [1, 102.6409816066066],
    [2, 102.41771200000001], [3, 101.638032], [4, 101.375],
    [6, 101.6894899764151], [8, 103.91221992924528]];
  for (const [x, y] of expected) assert.ok(Math.abs(curve.find(p => p[0] === x)[1] - y) < 1e-10);
  for (const p of points) assert.deepEqual(curve.find(q => q[0] === p[0]), p);
  for (const [x, y] of curve) {
    const i = points.findIndex(p => p[0] >= x);
    if (i > 0) assert.ok(y >= Math.min(points[i - 1][1], points[i][1]) - 1e-10
      && y <= Math.max(points[i - 1][1], points[i][1]) + 1e-10);
  }
  assert.deepEqual(points, before);
});

test('sampling follows viewport width, device pixels and zoom while using full-segment derivatives', () => {
  const small = horizonCurve(points, { width: 18, xRange: [0, 9] });
  const large = horizonCurve(points, { width: 36, xRange: [0, 9] });
  assert.deepEqual(large, horizonCurve(points, { width: 18, xRange: [0, 9], pixelRatio: 2 }));
  assert.ok(large.length > small.length);
  const zoom = horizonCurve(points, { width: 18, xRange: [1, 3] });
  assert.ok(zoom.filter(p => p[0] >= 1 && p[0] <= 3).length > small.filter(p => p[0] >= 1 && p[0] <= 3).length);
  assert.deepEqual(zoom.find(p => p[0] === 2), small.find(p => p[0] === 2));
  const dense = horizonCurve(points, { width: 1000000, xRange: [0, 9] });
  assert.ok(dense.length <= 32001 + points.length);
  assert.deepEqual(horizonCurve(points, { width: 0, xRange: [0, 9] }), points);
});

test('empty/single/two-point paths, gaps and conflicting x coordinates retain raw meaning', () => {
  const viewport = { width: 100, xRange: [0, 9] };
  assert.deepEqual(horizonCurve([], viewport), []);
  assert.deepEqual(horizonCurve([[1, 2.25]], viewport), [[1, 2.25]]);
  const linear = horizonCurve([[0, 1.125], [9, 10.125]], viewport);
  for (const [x, y] of linear) assert.ok(Math.abs(y - x - 1.125) < 1e-12);
  const gap = [[0, 1], [1, 2], [null, null], [4, 8], [5, 9]];
  const curve = horizonCurve(gap, viewport);
  assert.equal(curve.filter(p => p[0] === null).length, 1);
  assert.ok(curve.every(p => p[0] === null || p[0] <= 1 || p[0] >= 4));
  for (const raw of [[[0, 1], [0, 2], [1, 3]], [[2, 1], [1, 2], [0, 3]]]) {
    assert.deepEqual(horizonCurve(raw, viewport), raw);
  }
});
