import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/components/plotScrollMath.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
} }).outputText;
const { scrollMetrics, scrollWindow } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

test('thumb size and position describe the visible part of the full survey', () => {
  const m = scrollMetrics([0, 1000], [300, 550], 400);
  assert.equal(m.enabled, true);
  assert.equal(m.size, 100);
  assert.equal(m.position, 120);
  assert.equal(m.fraction, .4);
});

test('navigation preserves zoom and stops exactly at either data edge', () => {
  assert.deepEqual(scrollWindow([310, 1205], [600, 800], -1), [310, 510]);
  assert.deepEqual(scrollWindow([310, 1205], [600, 800], 2), [1005, 1205]);
});

test('time grows downward while an ascending map y-axis grows upward', () => {
  assert.deepEqual(scrollWindow([200, 1200], [600, 400], 1), [1200, 1000]);
  assert.deepEqual(scrollWindow([110, 695], [300, 500], 0, true), [495, 695]);
  assert.deepEqual(scrollWindow([110, 695], [300, 500], 1, true), [110, 310]);
});

test('reversed horizontal axes preserve their direction', () => {
  assert.deepEqual(scrollWindow([0, 100], [80, 60], 0, true), [100, 80]);
});

test('minimum grab size does not alter the actual data window', () => {
  const m = scrollMetrics([0, 10000], [5000, 5010], 100);
  assert.equal(m.size, 28);
  assert.equal(m.travel, 72);
  assert.deepEqual(scrollWindow([0, 10000], [5000, 5010], 1), [9990, 10000]);
});

test('full-range, over-zoomed-out, empty and tiny tracks are non-scrollable', () => {
  for (const range of [[0, 100], [-20, 120], [50, 50]])
    assert.equal(scrollMetrics([0, 100], range, 400).enabled, false);
  assert.equal(scrollMetrics([0, 0], [0, 0], 400).enabled, false);
  assert.equal(scrollMetrics([0, 100], [20, 30], 20).travel, 0);
});

test('minimum thumb hit geometry still reaches each edge without drift', () => {
  const m = scrollMetrics([0, 10000], [5000, 5010], 100);
  const atEnd = m.fraction + (m.travel - m.position) / m.travel;
  assert.deepEqual(scrollWindow([0, 10000], [5000, 5010], atEnd), [9990, 10000]);
});
