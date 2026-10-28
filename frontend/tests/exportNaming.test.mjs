import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/exportNaming.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { exportNameRequest } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

test('auto naming ignores rendering changes and never reuses a previous explicit name', () => {
  const request = { kind: 'map', filename: 'old.png', state: { horizon: 'h', color_by: 'twt' }, settings: { long_edge: 600 } };
  const before = exportNameRequest(request, 'png', null);
  const changed = structuredClone(request);
  changed.state.colormap = 'RdBu'; changed.state.x_range = [2, 4]; changed.settings.long_edge = 3000;
  assert.deepEqual(exportNameRequest(changed, 'png', null), before);
  assert.equal(before.filename, null);
  assert.equal(exportNameRequest(changed, 'pdf', 'mine').filename, 'mine');
  assert.equal(exportNameRequest(changed, 'pdf', 'mine').settings.format, 'pdf');
});

test('live 3D camera and captured pixels cannot invalidate or inflate a name request', () => {
  const request = { kind: '3d', png: 'large-capture', state: { scene: { camera: { eye: 1 } }, slices: { inline: [{ id:'il', position:12, opacity:.2 }] }, horizons:[{id:'h',name:'H1',color:'#000000'}] } };
  const before = exportNameRequest(request, 'png', null);
  request.state.scene.camera.eye = 2; request.state.slices.inline[0].opacity = 1; request.state.horizons[0].color = '#ffffff';
  assert.deepEqual(exportNameRequest(request, 'png', null), before);
  assert.ok(!JSON.stringify(before).includes('large-capture'));
  request.state.slices.inline[0].position = 15;
  assert.notDeepEqual(exportNameRequest(request, 'png', null), before);
});

test('profile direction and comparison members remain naming inputs', () => {
  const request = {kind:'profile',state:{horizon:'h'},a:[10,30],b:[12,33]};
  assert.notDeepEqual(exportNameRequest(request,'svg',null), exportNameRequest({...request,a:request.b,b:request.a},'svg',null));
  const map = {kind:'map',state:{horizon:'h',color_by:'difference',difference_reference:'a',difference_comparison:'b'}};
  assert.notDeepEqual(exportNameRequest(map,'png',null), exportNameRequest({...map,state:{...map.state,difference_comparison:'c'}},'png',null));
});
