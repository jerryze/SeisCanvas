import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/components/SeismicViewer3D/axisTitles.ts',import.meta.url),'utf8');
const code = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {applyTimeAxisTitleRotation} = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

test('Time title rotates by 180 degrees relative to native alignment without affecting other titles or accumulating on reapply', () => {
  const calls = [];
  const text = {drawLabel(...args){assert.equal(this,text);calls.push(args);return 'drawn';}};
  const axes = {_text:text};
  applyTimeAxisTitleRotation(axes);
  applyTimeAxisTitleRotation(axes);
  assert.equal(text.drawLabel(2,12,.2,[1,2,3]),'drawn');
  assert.deepEqual(calls.pop(),[2,12,.2 + Math.PI,[1,2,3]]);
  for (const axis of [0,1]) {
    text.drawLabel(axis,12,.3);
    assert.deepEqual(calls.pop(),[axis,12,.3]);
  }
  applyTimeAxisTitleRotation({});
});
