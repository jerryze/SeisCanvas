import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/api/client.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const client = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const response = revision => new Response('{}', { headers: { 'X-Project-Revision': String(revision) } });

// These tests verify the shared transport contract, including consumers outside App.
test('config writes wait in order and send the latest acknowledged revision', async () => {
  const first = deferred();
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push({ url, init }); return sent.length === 1 ? first.promise : response(9); };
  client.setApiProject({ project_id: 'a', activation_epoch: 'epoch-a', revision: 7 });
  const save = client.api('/workspace', { ...client.json({ project_id: 'a', revision: 0, state: {} }), method: 'PUT' });
  const rename = client.api('/horizons/h', { ...client.json({ name: 'A' }), method: 'PATCH' });
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].init.headers.get('X-SeisCanvas-Project'), 'a');
  assert.equal(JSON.parse(sent[0].init.body).revision, 7);
  first.resolve(response(8));
  await Promise.all([save, rename]);
  assert.equal(sent[1].init.headers.get('X-SeisCanvas-Revision'), '8');
  assert.equal(client.getApiProject().revision, 9);
});

test('responses from a previous activation are rejected without touching the new cursor', async () => {
  const pending = deferred();
  globalThis.fetch = () => pending.promise;
  client.setApiProject({ project_id: 'a', activation_epoch: 'epoch-a', revision: 0 });
  const result = client.api('/section', client.json({ section_number: 10 }));
  client.setApiProject({ project_id: 'b', activation_epoch: 'epoch-b', revision: 20 });
  pending.resolve(response(1));
  await assert.rejects(result, error => error.code === 'STALE_RESPONSE');
  assert.equal(client.getApiProject().revision, 20);
});

test('read requests cannot acknowledge a revision committed by another tab', async () => {
  globalThis.fetch = async () => response(100);
  client.setApiProject({ project_id: 'a', activation_epoch: 'epoch-a', revision: 2 });
  await client.api('/export/queue');
  assert.equal(client.getApiProject().revision, 2);
});

test('structured conflict errors preserve a stable code and actionable message', async () => {
  const error = await client.apiError(new Response(JSON.stringify({ detail: { code: 'PROJECT_CHANGED', message: '请重新加载', issues: [] } }), { status: 409 }));
  assert.equal(error.code, 'PROJECT_CHANGED');
  assert.equal(error.message, '请重新加载');
});

test('figure URLs keep their immutable project owner even when queue IDs overlap', () => {
  const a = client.projectFileUrl('exp_0001', '图件 A.png', 'project-a');
  const b = client.projectFileUrl('exp_0001', '图件 A.png', 'project-b');
  assert.equal(new URL(a, 'http://localhost').searchParams.get('project_id'), 'project-a');
  assert.notEqual(a, b);
});
