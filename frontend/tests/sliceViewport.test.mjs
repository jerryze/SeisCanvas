import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const uri = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}
}).outputText).toString('base64');
const root='../src/components/';
const axis=uri(await readFile(new URL(root+'SeismicViewer3D/axisJunctions.ts',import.meta.url),'utf8'));
const style=uri(await readFile(new URL(root+'plotStyle.ts',import.meta.url),'utf8'));
const geometry=uri((await readFile(new URL(root+'SeismicViewer3D/sceneGeometry.ts',import.meta.url),'utf8')).replace('"../plotStyle"',JSON.stringify(style)));
const uniformURL=uri(await readFile(new URL(root+'SeismicViewer3D/shaderUniforms.ts',import.meta.url),'utf8'));
const source=(await readFile(new URL(root+'SeismicViewer3D/sliceViewport.ts',import.meta.url),'utf8')).replace('"./axisJunctions"',JSON.stringify(axis)).replace('"./sceneGeometry"',JSON.stringify(geometry)).replace('"./shaderUniforms"',JSON.stringify(uniformURL));
const { measureSliceViewports }=await import(uri(source));
const identity=()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function element(width=1000,height=500) {
  const uniforms={model:identity(),view:[1,0,0,0,0,0,1,0,0,1,0,0,0,0,0,1],projection:identity()};
  const scene={dataScale:[1,1,1],glplot:{gl:{},axes:{_lines:{shader:{uniforms}}}}};
  return {clientWidth:width,clientHeight:height,_fullLayout:{scene:{_scene:scene}}};
}
const data={slices:[{id:'il',kind:'inline',position:0,a:[-.4,.4],b:[-.8,.8],source_a_range:[-.5,.5],source_b_range:[-1,1]}]};
test('projected CSS spans use original plane coordinates, with stable quantization',()=>{
  const el=element();assert.deepEqual(measureSliceViewports(el,data),{il:[512,512]});
  assert.deepEqual(measureSliceViewports(element(1001,501),data),{il:[512,512]});
  assert.deepEqual(measureSliceViewports({},data),{});
});
test('camera zoom and viewport resize increase sampling density, while dataScale retains physical coordinates',()=>{
  const el=element();const before=measureSliceViewports(el,data).il;
  const m=el._fullLayout.scene._scene.glplot.axes._lines.shader.uniforms.model;
  m[0]=2;m[10]=2;
  const zoom=measureSliceViewports(el,data).il;
  assert.ok(zoom[0]>before[0]&&zoom[1]>before[1]);
  assert.ok(measureSliceViewports(element(2000,1000),data).il[0]>before[0]);
  el._fullLayout.scene._scene.dataScale=[.5,.5,.5];
  assert.deepEqual(measureSliceViewports(el,data).il,before);
});
