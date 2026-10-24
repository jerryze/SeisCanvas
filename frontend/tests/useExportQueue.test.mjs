import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64');
const react = moduleURL(`
  const slot = initial => {
    const h = globalThis.exportQueueTest, i = h.cursor++;
    return h.slots[i] ??= initial();
  };
  export function useState(initial) {
    const h = globalThis.exportQueueTest, s = slot(() => ({ value: initial }));
    return [s.value, next => {
      if (h.unmounted) h.lateUpdates++;
      const value = typeof next === 'function' ? next(s.value) : next;
      if (!Object.is(value, s.value)) h.changed = true;
      s.value = value;
    }];
  }
  export const useRef = initial => slot(() => ({ current: initial }));
  export function useEffect(effect, deps) {
    const h = globalThis.exportQueueTest, s = slot(() => ({}));
    if (!s.deps || deps.some((value, i) => !Object.is(value, s.deps[i])))
      h.pending.push(() => { s.cleanup?.(); s.deps = deps; s.cleanup = effect(); });
  }
  export function useCallback(callback, deps) {
    const s = slot(() => ({}));
    if (!s.deps || deps.some((value, i) => !Object.is(value, s.deps[i]))) { s.deps = deps; s.callback = callback; }
    return s.callback;
  }
`);
const api = moduleURL(`
  export class ApiError extends Error {}
  export const json = value => ({ method: 'POST', body: JSON.stringify(value) });
  export const getApiProject = () => globalThis.exportQueueTest.owner;
  export const api = (path, init) => new Promise((resolve, reject) =>
    globalThis.exportQueueTest.requests.push({ path, init, resolve, reject, handled: false }));
`);
const source = (await readFile(new URL('../src/hooks/useExportQueue.ts', import.meta.url), 'utf8'))
  .replace('"react"', JSON.stringify(react)).replace('"../api/client"', JSON.stringify(api));
const { useExportQueue } = await import(moduleURL(source));
const settled = () => new Promise(resolve => setImmediate(resolve));
const job = (status = 'queued', patch = {}) => ({ id: 'j1', project_id: 'p1', kind: '2d', status,
  stage: status, label: 'Inline 300', error: null, item: null, created_at: 'now', updated_at: 'now', timings: {}, attempts: 1, ...patch });
const item = { id: 'f1', filename: '300.png' };

async function withHarness(run) {
  const saved = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, document: globalThis.document };
  let now = 0, next = 0;
  const listeners = new Map();
  const h = globalThis.exportQueueTest = { slots: [], pending: [], requests: [], timers: new Map(), errors: [], notices: [], tasks: [], lateUpdates: 0,
    owner: { project_id: 'p1', activation_epoch: 'a1', revision: 1 } };
  globalThis.document = { hidden: false, addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) };
  globalThis.setTimeout = (callback, delay) => { h.timers.set(++next, { callback, due: now + delay }); return next; };
  globalThis.clearTimeout = id => h.timers.delete(id);
  const opts = { task: async (label, fn) => { h.tasks.push(label); await fn(); }, notify: m => h.notices.push(m), onError: m => h.errors.push(m) };
  h.render = () => {
    do {
      h.changed = false; h.cursor = 0; h.pending = [];
      h.result = useExportQueue(opts);
      for (const effect of h.pending) effect();
    } while (h.changed);
    return h.result;
  };
  h.advance = wait => {
    now += wait;
    for (const [id, { callback, due }] of [...h.timers]) if (due <= now) { h.timers.delete(id); void callback(); }
  };
  h.take = (path, method = 'GET') => {
    const request = h.requests.find(r => !r.handled && r.path === path && (r.init?.method || 'GET') === method);
    assert.ok(request, `missing ${method} ${path}`); request.handled = true; return request;
  };
  h.complete = async (request, data) => {
    request.resolve({ json: async () => data });
    await settled(); if (!h.unmounted) h.render();
  };
  h.baseline = async (jobs = []) => {
    await h.complete(h.take('/export/queue'), { items: [], session: 'session1' });
    await h.complete(h.take('/export/jobs'), { jobs });
  };
  h.visibility = hidden => { document.hidden = hidden; listeners.get('visibilitychange')?.(); };
  h.unmount = () => { for (const s of h.slots) s.cleanup?.(); h.unmounted = true; };
  try { h.render(); await run(h); }
  finally { if (!h.unmounted) h.unmount(); Object.assign(globalThis, saved); delete globalThis.exportQueueTest; }
}

test('submission returns at queued status without global busy and serializes a fixed request', () => withHarness(async h => {
  await h.baseline();
  const body = { kind: '2d', state: { section_number: 300 } };
  const promise = h.result.submitJob(body); h.render();
  assert.equal(h.result.submitting, true);
  const request = h.take('/export/jobs', 'POST');
  body.state.section_number = 400;
  assert.equal(JSON.parse(request.init.body).state.section_number, 300);
  await h.complete(request, job());
  assert.equal((await promise).status, 'queued');
  assert.equal(h.result.submitting, false);
  assert.equal(h.result.activeJobCount, 1);
  assert.deepEqual(h.tasks, []);
  assert.match(h.notices[0], /可继续浏览/);
  await h.complete(h.take('/export/jobs'), { jobs: [job('running', { stage: 'rendering' })] });
  const count = h.requests.length; h.advance(999); assert.equal(h.requests.length, count);
  h.advance(1); assert.equal(h.requests.length, count + 1);
}));

test('completion refreshes figures and notifies once, including a successful retry attempt', () => withHarness(async h => {
  await h.baseline([job()]);
  h.advance(1000);
  await h.complete(h.take('/export/jobs'), { jobs: [job('completed', { item })] });
  await h.complete(h.take('/export/queue'), { items: [item], session: 'session1' });
  assert.deepEqual(h.result.items, [item]);
  assert.equal(h.notices.length, 1);
  h.advance(5000); await h.complete(h.take('/export/jobs'), { jobs: [job('completed', { item })] });
  assert.equal(h.notices.length, 1);
  h.advance(5000); await h.complete(h.take('/export/jobs'), { jobs: [job('failed', { error: 'disk full', attempts: 2 })] });
  assert.equal(h.errors.length, 0, 'background failures must not overwrite browsing errors');
  assert.equal(h.notices.filter(s => s.includes('可在导出队列重试')).length, 1);
  assert.equal(h.result.jobs[0].error, 'disk full', 'durable details stay on the failed job row');
  const retry = h.result.retryJob(job('failed')); h.render();
  assert.equal(h.result.pendingJobIds.has('j1'), true);
  await h.complete(h.take('/export/jobs/j1/retry', 'POST'), job('queued', { attempts: 3 })); await retry;
  await h.complete(h.take('/export/jobs'), { jobs: [job('completed', { item, attempts: 3 })] });
  assert.equal(h.notices.filter(s => s.startsWith('已保存图件')).length, 2);
  assert.equal(h.result.pendingJobIds.size, 0);
}));

test('historical terminal jobs load silently while initial queue is refreshed for completed jobs', () => withHarness(async h => {
  await h.baseline([job('completed', { item }), job('failed', { id: 'j2', error: 'old failure' })]);
  assert.equal(h.notices.length, 0); assert.equal(h.errors.length, 0);
  await h.complete(h.take('/export/queue'), { items: [item], session: 'session1' });
  assert.deepEqual(h.result.items, [item]);
}));

test('an earlier list response cannot erase an accepted submission or cancellation', () => withHarness(async h => {
  const initial = h.take('/export/jobs');
  await h.complete(h.take('/export/queue'), { items: [], session: 'session1' });
  const submit = h.result.submitJob({ kind: '2d' });
  await h.complete(h.take('/export/jobs', 'POST'), job()); await submit;
  await h.complete(initial, { jobs: [] });
  assert.equal(h.result.jobs[0].id, 'j1');
  h.advance(0);
  const beforeCancel = h.take('/export/jobs');
  const cancel = h.result.cancelJob(job());
  const duplicate = h.result.cancelJob(job()); await duplicate;
  assert.equal(h.requests.filter(r => r.path.endsWith('/cancel')).length, 1);
  await h.complete(h.take('/export/jobs/j1/cancel', 'POST'), job('cancelled')); await cancel;
  await h.complete(beforeCancel, { jobs: [job()] });
  assert.equal(h.result.jobs[0].status, 'cancelled');
  assert.equal(h.result.activeJobCount, 0);
}));

test('hidden tabs stop polling and resume promptly without overlapping requests', () => withHarness(async h => {
  await h.baseline([job()]); h.advance(1000);
  const request = h.take('/export/jobs');
  h.visibility(true);
  assert.equal(request.init.signal.aborted, true);
  h.visibility(false);
  const count = h.requests.length;
  await h.complete(request, { jobs: [job('completed', { item })] });
  assert.equal(h.notices.length, 0);
  h.advance(0);
  assert.equal(h.requests.length, count + 1);
  await h.complete(h.take('/export/jobs'), { jobs: [job('running')] });
  h.visibility(true); h.advance(10000);
  assert.equal(h.requests.length, count + 1);
  h.visibility(false);
  assert.equal(h.requests.length, count + 2);
}));

test('poll errors are deduplicated and backed off; project conflicts stop future polls', () => withHarness(async h => {
  await h.baseline([job()]); h.advance(1000);
  h.take('/export/jobs').reject(new Error('network')); await settled(); h.render();
  h.advance(4999); const count = h.requests.length;
  h.advance(1); assert.equal(h.requests.length, count + 1);
  h.take('/export/jobs').reject(new Error('network')); await settled(); h.render();
  assert.deepEqual(h.errors, ['network']);
  h.advance(5000);
  h.take('/export/jobs').reject(Object.assign(new Error('changed'), { code: 'PROJECT_CHANGED' }));
  await settled(); h.render();
  const finalCount = h.requests.length; h.advance(60000); h.visibility(false);
  assert.equal(h.requests.length, finalCount);
  assert.deepEqual(h.errors, ['network', 'changed']);
}));

test('submission failures reject so export dialogs can stay open, with busy released', () => withHarness(async h => {
  await h.baseline();
  const submit = h.result.submitJob({ kind: '2d' });
  const rejected = assert.rejects(submit, /full/);
  h.take('/export/jobs', 'POST').reject(new Error('full')); await rejected; await settled(); h.render();
  assert.equal(h.result.submitting, false);
  assert.deepEqual(h.errors, ['full']); assert.deepEqual(h.tasks, []);
}));

test('unmount aborts requests and timers and ignores delayed JSON parsing', () => withHarness(async h => {
  await h.baseline([job()]); h.advance(1000);
  const request = h.take('/export/jobs');
  let finishBody;
  request.resolve({ json: () => new Promise(resolve => finishBody = resolve) }); await settled();
  h.unmount();
  assert.equal(request.init.signal.aborted, true);
  finishBody({ jobs: [job('completed', { item })] }); await settled();
  h.advance(60000);
  assert.equal(h.timers.size, 0); assert.equal(h.lateUpdates, 0); assert.equal(h.notices.length, 0);
}));

test('project activation during response parsing cannot update the previous project', () => withHarness(async h => {
  await h.baseline();
  const submit = h.result.submitJob({ kind: 'map' });
  const request = h.take('/export/jobs', 'POST');
  let finishBody;
  request.resolve({ json: () => new Promise(resolve => finishBody = resolve) }); await settled();
  h.owner = { project_id: 'p2', activation_epoch: 'a2', revision: 1 };
  finishBody(job()); await submit; await settled(); h.render();
  assert.equal(h.result.jobs.length, 0); assert.equal(h.notices.length, 0);
}));

test('a poll finishing before a delayed submission acknowledgement cannot regress or double-announce completion', () => withHarness(async h => {
  await h.baseline(); h.advance(5000);
  const poll = h.take('/export/jobs');
  const submit = h.result.submitJob({ kind: '2d' });
  const request = h.take('/export/jobs', 'POST');
  let finishBody;
  request.resolve({ json: () => new Promise(resolve => finishBody = resolve) }); await settled();
  await h.complete(poll, { jobs: [job('completed', { item })] });
  assert.equal(h.notices.length, 0);
  finishBody(job()); await submit; await settled(); h.render();
  await h.complete(h.take('/export/jobs'), { jobs: [job('completed', { item })] });
  assert.equal(h.notices.filter(s => s.startsWith('已保存图件')).length, 1);
  assert.equal(h.result.activeJobCount, 0);
}));

test('a delayed retry acknowledgement cannot overwrite a terminal status already seen by polling', () => withHarness(async h => {
  await h.baseline([job('failed', { error: 'disk full' })]); h.advance(5000);
  const poll = h.take('/export/jobs');
  const retry = h.result.retryJob(job('failed'));
  const request = h.take('/export/jobs/j1/retry', 'POST');
  let finishBody;
  request.resolve({ json: () => new Promise(resolve => finishBody = resolve) }); await settled();
  await h.complete(poll, { jobs: [job('completed', { item, attempts: 2 })] });
  assert.equal(h.notices.length, 0);
  finishBody(job('queued', { attempts: 2 })); await retry; await settled(); h.render();
  await h.complete(h.take('/export/jobs'), { jobs: [job('completed', { item, attempts: 2 })] });
  assert.equal(h.notices.filter(s => s.startsWith('已保存图件')).length, 1);
  assert.equal(h.result.jobs[0].status, 'completed');
}));
