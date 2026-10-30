import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/components/profilePlotRenderer.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { createProfilePlotRenderer } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
function harness() {
  const calls = [], errors = [];
  const el = { clientWidth: 800, clientHeight: 300 };
  const api = {
    async react(el, traces, layout) { calls.push(['react']); el.data = traces; el.layout = layout; el._fullLayout = { width: 800, height: 300 }; },
    async restyle(el, update, indices) { calls.push(['restyle', update, indices]); },
    async relayout(el, update) { calls.push(['relayout', update]); },
    purge() { calls.push(['purge']); },
  };
  const renderer = createProfilePlotRenderer(api, el, error => errors.push(error));
  const background = { type: 'heatmap', z: [[1, 2], [3, 4]] };
  const traces = [background, { type: 'scatter', name: 'Wiggle' },
    { meta: { horizonId: 'a' }, name: 'outline' }, { meta: { horizonId: 'a' }, name: 'line+markers' },
    { meta: { horizonId: 'b' }, name: 'other horizon' }];
  return { renderer, api, el, traces, background, calls, errors };
}

test('profile visibility only restyles horizon slots, preserving background, viewport and zoom', async () => {
  const h = harness();
  const layout = { xaxis: { range: [10, 20] }, yaxis: { range: [600, 200] } };
  await h.renderer.visibility([{ id: 'a', visible: true }, { id: 'b', visible: true }]);
  await h.renderer.render(h.traces, layout, {}, () => {});
  await h.renderer.visibility([{ id: 'a', visible: false }, { id: 'b', visible: true }]);
  assert.deepEqual(h.calls.at(-1), ['restyle', { visible: [false, false] }, [2, 3]]);
  assert.equal(h.el.data[0], h.background);
  assert.equal(h.el.layout, layout);
  assert.equal(h.el.data[0].visible, undefined);
  assert.equal(h.el.data[1].visible, undefined);
  await h.renderer.visibility([{ id: 'a', visible: false }, { id: 'b', visible: false }]);
  await h.renderer.visibility([{ id: 'a', visible: true }, { id: 'b', visible: true }]);
  const before = h.calls.length;
  await h.renderer.visibility([{ id: 'a', visible: true }, { id: 'b', visible: true }]);
  await h.renderer.resize(800, 300, () => assert.fail('unchanged size must not resample'));
  assert.equal(h.calls.length, before);
  assert.equal(h.calls.filter(c => c[0] === 'react').length, 1);
  assert.equal(h.calls.filter(c => c[0] === 'relayout').length, 0);
  assert.deepEqual(h.errors, []);
});

test('toggles during an in-flight plot apply the newest visibility after rendering', async () => {
  const h = harness();
  let release;
  const blocker = new Promise(resolve => { release = resolve; });
  const react = h.api.react;
  h.api.react = async (...args) => { await blocker; await react(...args); };
  await h.renderer.visibility([{ id: 'a', visible: true }, { id: 'b', visible: false }]);
  let ready = 0;
  const rendering = h.renderer.render(h.traces, {}, {}, () => ready++);
  await new Promise(resolve => setImmediate(resolve));
  const hidden = h.renderer.visibility([{ id: 'a', visible: false }, { id: 'b', visible: false }]);
  const shown = h.renderer.visibility([{ id: 'a', visible: true }, { id: 'b', visible: true }]);
  const final = h.renderer.visibility([{ id: 'a', visible: false }, { id: 'b', visible: true }]);
  release();
  await Promise.all([rendering, hidden, shown, final]);
  assert.equal(ready, 1);
  assert.equal(h.el.data[2].visible, false);
  assert.equal(h.el.data[3].visible, false);
  assert.equal(h.el.data[4].visible, true);
  assert.equal(h.calls.filter(c => c[0] === 'react').length, 1);
  assert.deepEqual(h.errors, []);
});

test('only real resizing changes dimensions, and disposal suppresses late callbacks', async () => {
  const h = harness();
  await h.renderer.render(h.traces, {}, {}, () => {});
  let resized = 0;
  await h.renderer.resize(900, 320, () => resized++);
  await h.renderer.resize(900, 320, () => resized++);
  assert.equal(resized, 1);
  assert.deepEqual(h.calls.at(-1), ['relayout', { width: 900, height: 320 }]);
  await h.renderer.dispose();
  await h.renderer.visibility([{ id: 'a', visible: true }]);
  await h.renderer.render(h.traces, {}, {}, () => assert.fail('disposed plot'));
  assert.equal(h.calls.at(-1)[0], 'purge');
  assert.deepEqual(h.errors, []);
});

test('viewport updates preserve loaded background and foreground traces', async () => {
  const h = harness();
  await h.renderer.render(h.traces, {}, {}, () => {});
  let drawn = 0;
  await h.renderer.viewport({ 'xaxis.range': [15, 25], 'yaxis.range': [700, 300] }, () => drawn++);
  assert.equal(h.calls.filter(c => c[0] === 'react').length, 1);
  assert.equal(h.el.data, h.traces);
  assert.equal(h.el.data[0], h.background);
  assert.equal(drawn, 1);
  assert.deepEqual(h.calls.at(-1), ['relayout', { 'xaxis.range': [15, 25], 'yaxis.range': [700, 300] }]);
});

test('profile resizing applies the drawing frame atomically without resetting a free zoom selection', async () => {
  const h = harness();
  await h.renderer.render(h.traces, {}, {}, () => {});
  await h.renderer.viewport({ 'xaxis.range': [12, 12.5], 'yaxis.range': [190, 110] }, () => {});
  const frame = { 'xaxis.domain': [0.25, 0.75], 'yaxis.domain': [0, 1],
    'xaxis.scaleanchor': false, 'yaxis.scaleanchor': false };
  let measured = 0;
  await h.renderer.resize(1200, 600, () => measured++, frame);
  assert.deepEqual(h.calls.at(-1), ['relayout', { ...frame, width: 1200, height: 600 }]);
  assert.equal(measured, 1);
  assert.equal(h.el.data, h.traces);
  assert.equal(h.calls.filter(call => call[0] === 'react').length, 1);
  const before = h.calls.length;
  await h.renderer.viewport({ ...frame, width: 1400, height: 700 }, () => {});
  await h.renderer.resize(1400, 700, () => assert.fail('viewport already applied these dimensions'), frame);
  assert.equal(h.calls.length, before + 1);
});
