import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/components/probeController.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { createProbeController } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const settled = () => new Promise(resolve => setImmediate(resolve));
const point = position => ({ kind: 'inline', position, crossline: 12, time: 100 });
const reading = request => ({ ...request, inline: request.position, amplitude: request.position, source: 'original' });

function harness(delay) {
  let now = 0, next = 0;
  const timers = new Map(), requests = [], readings = [];
  const controller = createProbeController({
    delay,
    schedule(callback, wait) { const id = ++next; timers.set(id, { callback, due: now + wait }); return id; },
    cancel(id) { timers.delete(id); },
    request(value, signal) {
      return new Promise((resolve, reject) => requests.push({ value, signal, resolve, reject }));
    },
    onReading: value => readings.push(value),
  });
  function advance(wait) {
    now += wait;
    for (const [id, { callback, due }] of [...timers]) {
      if (due <= now) { timers.delete(id); callback(); }
    }
  }
  async function complete(index) {
    requests[index].resolve(reading(requests[index].value));
    await settled();
  }
  return { controller, requests, readings, timers, advance, complete };
}

test('debounces for 60 ms and only requests the latest cursor position', async () => {
  const h = harness();
  h.controller.probe(point(1));
  h.advance(59);
  assert.equal(h.requests.length, 0);
  h.controller.probe(point(2));
  h.advance(59);
  assert.equal(h.requests.length, 0);
  h.advance(1);
  assert.deepEqual(h.requests.map(r => r.value), [point(2)]);
  await h.complete(0);
  assert.deepEqual(h.readings, [reading(point(2))]);
});

test('a cached position cancels another scheduled sample without a request', async () => {
  const h = harness();
  h.controller.probe(point(1)); h.advance(60); await h.complete(0);
  h.controller.probe(point(2));
  h.controller.probe(point(1));
  assert.equal(h.timers.size, 0);
  h.advance(60);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.readings.at(-1), reading(point(1)));
});

test('a cached position aborts an in-flight sample and rejects its late response', async () => {
  const h = harness();
  h.controller.probe(point(1)); h.advance(60); await h.complete(0);
  h.controller.probe(point(2)); h.advance(60);
  h.controller.probe(point(1));
  assert.equal(h.requests[1].signal.aborted, true);
  await h.complete(1); // Intentionally ignore cancellation, like a completed body parse.
  assert.deepEqual(h.readings.map(r => r.position), [1, 1]);
});

test('out-of-order responses never replace the most recent selection', async () => {
  const h = harness();
  h.controller.probe(point(1)); h.advance(60);
  h.controller.probe(point(2)); h.advance(60);
  assert.equal(h.requests[0].signal.aborted, true);
  await h.complete(1);
  await h.complete(0);
  assert.deepEqual(h.readings, [reading(point(2))]);
});

test('reset cancels timers and in-flight samples while retaining accepted cache entries', async () => {
  const h = harness();
  h.controller.probe(point(1)); h.advance(60); await h.complete(0);
  h.controller.probe(point(2));
  h.controller.reset();
  assert.equal(h.timers.size, 0);
  h.advance(60);
  assert.equal(h.requests.length, 1);
  h.controller.probe(point(3)); h.advance(60);
  h.controller.reset();
  assert.equal(h.requests[1].signal.aborted, true);
  await h.complete(1);
  assert.equal(h.readings.at(-1), null);
  h.controller.probe(point(1));
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.readings.at(-1), reading(point(1)));
});

test('dispose cancels pending work and prevents callbacks or future requests', async () => {
  const scheduled = harness();
  scheduled.controller.probe(point(1));
  scheduled.controller.dispose();
  scheduled.advance(60);
  assert.equal(scheduled.timers.size, 0);
  assert.equal(scheduled.requests.length, 0);
  const h = harness();
  h.controller.probe(point(1)); h.advance(60);
  h.controller.dispose();
  assert.equal(h.requests[0].signal.aborted, true);
  await h.complete(0);
  h.controller.probe(point(2)); h.controller.reset(); h.controller.dispose();
  h.advance(60);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.readings, []);
});

test('sample failures stay silent and the same position can be retried', async () => {
  const h = harness();
  h.controller.probe(point(1)); h.advance(60);
  h.requests[0].reject(new Error('missing trace'));
  await settled();
  assert.deepEqual(h.readings, []);
  h.controller.probe(point(1)); h.advance(60); await h.complete(1);
  assert.deepEqual(h.readings, [reading(point(1))]);
});

test('cache identity includes all original coordinates and respects a custom delay', async () => {
  const h = harness(100);
  const positions = [point(1), { ...point(1), crossline: 13 }, { ...point(1), time: 101 },
    { ...point(1), kind: 'crossline', inline: 12 }, { ...point(1), kind: 'time' }];
  for (const [index, value] of positions.entries()) {
    h.controller.probe(value); h.advance(99);
    assert.equal(h.requests.length, index);
    h.advance(1); await h.complete(index);
  }
  for (const value of positions) h.controller.probe(value);
  assert.equal(h.requests.length, positions.length);
  assert.equal(h.timers.size, 0);
});

test('the React hook disposes on unmount and creates a live controller after StrictMode cleanup', async () => {
  const moduleURL = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64');
  const react = moduleURL(`
    export const useCallback = callback => callback;
    export const useRef = value => ({ current: value });
    export const useState = value => [value, next => globalThis.probeHookTest.readings.push(next)];
    export const useEffect = effect => globalThis.probeHookTest.effects.push(effect);
  `);
  const api = moduleURL(`
    export const json = value => ({ body: JSON.stringify(value) });
    export const api = (path, init) => new Promise(resolve =>
      globalThis.probeHookTest.requests.push({ path, init, resolve }));
  `);
  const hookSource = (await readFile(new URL('../src/components/Probe.tsx', import.meta.url), 'utf8'))
    .replace('"react"', JSON.stringify(react))
    .replace('"../api/client"', JSON.stringify(api))
    .replaceAll('"./probeController"', JSON.stringify(moduleURL(compiled)));
  const hookCompiled = ts.transpileModule(hookSource, { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
  } }).outputText;
  const { useOriginalProbe } = await import(moduleURL(hookCompiled));
  const previousSetTimeout = globalThis.setTimeout, previousClearTimeout = globalThis.clearTimeout;
  const h = globalThis.probeHookTest = { effects: [], readings: [], requests: [], timers: new Map() };
  let next = 0, cleanup;
  globalThis.setTimeout = callback => { h.timers.set(++next, callback); return next; };
  globalThis.clearTimeout = timer => h.timers.delete(timer);
  const runTimers = () => {
    for (const [id, callback] of [...h.timers]) { h.timers.delete(id); callback(); }
  };
  try {
    const { probe } = useOriginalProbe();
    assert.equal(h.effects.length, 1);
    cleanup = h.effects[0]();
    probe(point(1)); runTimers();
    assert.equal(h.requests[0].path, '/sample');
    cleanup();
    assert.equal(h.requests[0].init.signal.aborted, true);
    cleanup = h.effects[0](); // StrictMode replays effect setup after cleanup.
    probe(point(2)); runTimers();
    h.requests[0].resolve({ json: async () => reading(point(1)) });
    h.requests[1].resolve({ json: async () => reading(point(2)) });
    await settled();
    assert.deepEqual(h.readings, [reading(point(2))]);
    probe(point(3));
    cleanup(); cleanup = undefined;
    assert.equal(h.timers.size, 0);
    runTimers();
    assert.equal(h.requests.length, 2);
  } finally {
    cleanup?.();
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
    delete globalThis.probeHookTest;
  }
});
