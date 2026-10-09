import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/components/SeismicViewer3D/exportCrop.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext}}).outputText;
const {contentBounds} = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
test('content bounds include white content and faint annotations, ignoring only transparency', () => {
  const rgba = new Uint8ClampedArray(100 * 80 * 4);
  rgba.set([255, 255, 255, 255], (20 * 100 + 30) * 4);
  rgba.set([0, 0, 0, 1], (50 * 100 + 70) * 4);
  assert.deepEqual(contentBounds(rgba, 100, 80, 5), {x:25,y:15,width:51,height:41});
});
test('content touching an edge receives external padding and an empty scene fails explicitly', () => {
  const rgba = new Uint8ClampedArray(10 * 10 * 4);
  assert.throws(() => contentBounds(rgba, 10, 10), /可见内容/);
  rgba[3] = 255;
  assert.deepEqual(contentBounds(rgba, 10, 10, 4), {x:-4,y:-4,width:9,height:9});
});
