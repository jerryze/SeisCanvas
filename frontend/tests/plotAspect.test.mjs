import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64');
const { plotAspectLayout } = await import(moduleURL(await readFile(new URL('../src/components/plotAspect.ts', import.meta.url), 'utf8')));
const { PROFILE_MARGIN, profileContainerViewport } = await import(moduleURL(await readFile(new URL('../src/components/horizonMapLogic.ts', import.meta.url), 'utf8')));
const sectionMargin = { l: 72, r: 28, t: 28, b: 60 };

test('fixed frames fit and centre in wide and tall windows while both zoom axes remain independent', () => {
  for (const margin of [sectionMargin, PROFILE_MARGIN]) {
    for (const [width, height] of [[1200, 800], [800, 1200], [480, 360]]) {
      for (const ratio of [0.02, 0.5, 1, 2, 50]) {
        const frame = plotAspectLayout(width, height, margin, ratio);
        const x = frame['xaxis.domain'], y = frame['yaxis.domain'];
        assert.ok([...x, ...y].every(value => value >= 0 && value <= 1));
        assert.equal(x[0] + x[1], 1);
        assert.equal(y[0] + y[1], 1);
        const actualWidth = (width - margin.l - margin.r) * (x[1] - x[0]);
        const actualHeight = (height - margin.t - margin.b) * (y[1] - y[0]);
        assert.ok(Math.abs(actualWidth / actualHeight - ratio) < 1e-10);
        assert.equal(frame['xaxis.scaleanchor'], false);
        assert.equal(frame['yaxis.scaleanchor'], false);
        assert.equal('xaxis.range' in frame, false);
        assert.equal('yaxis.range' in frame, false);
      }
    }
  }
});

test('turning off the aspect lock restores the full drawing area', () => {
  for (const ratio of [null, 0, NaN, Infinity, -1]) {
    const frame = plotAspectLayout(1000, 700, sectionMargin, ratio);
    assert.deepEqual(frame['xaxis.domain'], [0, 1]);
    assert.deepEqual(frame['yaxis.domain'], [0, 1]);
    assert.equal(frame['xaxis.scaleanchor'], false);
    assert.equal(frame['yaxis.scaleanchor'], false);
  }
});

test('A–B plot domains match the existing sampling viewport after margins and aspect fitting', () => {
  for (const [width, height] of [[1000, 700], [1200, 450], [600, 900]]) {
    for (const ratio of [null, 0.5, 1, 2]) {
      const frame = plotAspectLayout(width, height, PROFILE_MARGIN, ratio);
      const x = frame['xaxis.domain'], y = frame['yaxis.domain'];
      assert.deepEqual({
        width: Math.round((width - PROFILE_MARGIN.l - PROFILE_MARGIN.r) * (x[1] - x[0])),
        height: Math.round((height - PROFILE_MARGIN.t - PROFILE_MARGIN.b) * (y[1] - y[0])),
      }, profileContainerViewport(width, height, ratio));
    }
  }
});
