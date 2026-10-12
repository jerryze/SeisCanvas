import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const compile = source => ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(compile(source)).toString('base64');
const cropURL = moduleURL(await readFile(new URL('../src/components/SeismicViewer3D/exportCrop.ts',import.meta.url),'utf8'));
const junctionURL = moduleURL(await readFile(new URL('../src/components/SeismicViewer3D/axisJunctions.ts',import.meta.url),'utf8'));
const titleURL = moduleURL(await readFile(new URL('../src/components/SeismicViewer3D/axisTitles.ts',import.meta.url),'utf8'));
const source = (await readFile(new URL('../src/components/SeismicViewer3D/captureScene.ts',import.meta.url),'utf8')).replace('"./exportCrop"',JSON.stringify(cropURL)).replace('"./axisJunctions"',JSON.stringify(junctionURL)).replace('"./axisTitles"',JSON.stringify(titleURL));
const {projectedBounds,cropProjection,unpackPixels,captureScene} = await import(moduleURL(source));
const identity = () => [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];

test('projected bounds preserve camera content and fit projection maps the crop to the viewport', () => {
 const rect=projectedBounds([[[-.5,-.25,-.5],[.5,.25,.5]]],identity(),identity(),identity(),800,600,0);
 assert.deepEqual(rect,{x:200,y:225,width:400,height:150});
 const p=cropProjection(identity(),rect,800,600);
 assert.equal(p[0]*-.5+p[12],-1); assert.equal(p[0]*.5+p[12],1);
 assert.equal(p[5]*-.25+p[13],-1); assert.equal(p[5]*.25+p[13],1);
 const shifted=cropProjection(identity(),{x:100,y:100,width:400,height:300},800,600);
 assert.equal(shifted[0]*-.75+shifted[12],-1);
 assert.ok(Math.abs(shifted[5]*(1-2*100/600)+shifted[13]-1)<1e-12);
});

test('readback flips rows and reverses premultiplied alpha without destroying white seismic pixels', () => {
 const raw=new Uint8Array([64,32,16,128,255,255,255,255]);
 assert.deepEqual([...unpackPixels(raw,1,2)],[255,255,255,255,128,64,32,128]);
});

function fixture(fail=false) {
 const context={putImageData(){},fillRect(){},drawImage(){}};
 const makeCanvas=()=>({width:0,height:0,getContext:()=>context,toBlob(fn){fn({});}});
 globalThis.document={fonts:{load:async()=>{}},createElement:()=>makeCanvas()};
 globalThis.requestAnimationFrame=fn=>{fn();return 0;};
 globalThis.ImageData=class {constructor(data,width,height){Object.assign(this,{data,width,height});}};
 globalThis.FileReader=class {readAsDataURL(){this.result='data:image/png;base64,TEST';this.onload();}};
 const canvas=makeCanvas();canvas.width=800;canvas.height=600;
 const object={bounds:[[-.5,-.5,-.5],[.5,.5,.5]],texture:{},buffer:{}};
 const text={buffer:{update(){}},bind(){},drawTicks(){}};
 const originalText={upload:text.buffer.update,bind:text.bind,draw:text.drawTicks};
 const axes={_text:text,enable:true,tickPad:[10,10,10],labelPad:[30,30,30],lineTickLength:[5,5,5],update(p){Object.assign(this,p);text.buffer.update([]);}};
 const draws=[];const originalOnrender=()=>{};
 const renderer={canvas,axes,objects:[object],bounds:object.bounds,pixelRatio:1,autoResize:true,
  onrender:originalOnrender,clearColor:[1,1,1,1],selection:{object:null},
  cameraParams:{model:identity(),view:identity(),projection:identity()},
  redraw(){draws.push([canvas.width,canvas.height]);this.cameraParams.projection.set?.(identity());this.onrender();},
  gl:{MAX_RENDERBUFFER_SIZE:1,MAX_TEXTURE_SIZE:2,getParameter:()=>8192,isContextLost:()=>false,
    finish(){},bindFramebuffer(){},readPixels(x,y,w,h,fmt,type,data){
      if(fail)throw Error('readback failed');
      for(let y=20;y<h-20;y++)for(let x=20;x<w-20;x++)data[(y*w+x)*4+3]=255;
    }},
 };
 const camera={eye:{x:1,y:1,z:1},up:{x:0,y:0,z:1},center:{x:0,y:0,z:0}};
 return {renderer,object,draws,originalText,originalOnrender,element:{_fullLayout:{scene:{_scene:{glplot:renderer,traces:{},getCamera:()=>camera}}}}};
}
const settings={format:'png',canvas:'fit',long_edge:600,font:'Arial',font_size:10,background:'transparent',show_axes:true,show_axis_labels:true,show_bounding_box:false};

test('capture reuses objects and texture, renders once, then restores interactive resolution', async () => {
 const f=fixture();const result=await captureScene(f.element,settings);
 assert.equal(result.timings.high_resolution_renders,1);
 assert.equal(f.draws.length,2); // one export plus interactive restoration
 assert.equal(Math.max(...f.draws[0]),600); assert.deepEqual(f.draws[1],[800,600]);
 assert.equal(f.renderer.objects[0],f.object);assert.equal(f.renderer.onrender,f.originalOnrender);
 assert.equal(f.renderer.pixelRatio,1);assert.equal(f.renderer.autoResize,true);
 assert.equal(f.renderer.axes._text.drawTicks,f.originalText.draw);
 assert.equal(f.renderer.axes._text.buffer.update,f.originalText.upload);
 assert.equal(f.renderer.axes._text.bind,f.originalText.bind);
 assert.deepEqual(f.renderer.axes.tickPad,[10,10,10]);
 assert.deepEqual(f.renderer.axes.labelPad,[30,30,30]);
 assert.deepEqual(f.renderer.axes.lineTickLength,[5,5,5]);
 assert.equal(Math.max(result.width_px,result.height_px),600);
});

test('failed image readback still restores GPU presentation state and cached objects', async () => {
 const f=fixture(true);
 await assert.rejects(captureScene(f.element,settings),/readback failed/);
 assert.equal(f.renderer.objects[0],f.object);assert.equal(f.renderer.onrender,f.originalOnrender);
 assert.deepEqual([f.renderer.canvas.width,f.renderer.canvas.height],[800,600]);
 assert.deepEqual(f.renderer.clearColor,[1,1,1,1]);assert.equal(f.renderer.pixelRatio,1);
 assert.equal(f.renderer.axes._text.drawTicks,f.originalText.draw);
 assert.equal(f.renderer.axes._text.buffer.update,f.originalText.upload);
 assert.equal(f.renderer.axes._text.bind,f.originalText.bind);
});
