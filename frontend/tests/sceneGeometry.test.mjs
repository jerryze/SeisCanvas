import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../src/components/SeismicViewer3D/sceneGeometry.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {buildTraces,buildLayout}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const colors={seismic:[[0,'#000000'],[1,'#ffffff']]};
const plane=(kind,position)=>({id:kind,kind,position,a:[30,40],b:[200,204],amplitude:[[1,2],[3,null]]});
const state=()=>({seismic:{colormap:'seismic',reverse_colormap:false,reverse_polarity:false},slices:Object.fromEntries(['inline','crossline','time'].map(kind=>[kind,[{id:kind,visible:true,opacity:.8,border:{visible:false}}]])),horizons:[],scene:{show_axes:true,show_axis_labels:true,show_bounding_box:false,aspect_ratio:[1,1,.7],background:'#ffffff',camera:{eye:{x:1,y:2,z:3},up:{x:0,y:0,z:1},center:{x:0,y:0,z:0}}}});
const data=()=>({slices:[plane('inline',12),plane('crossline',33),plane('time',800)],horizons:{},bounds:{x:[30,40],y:[10,12],z:[200,1200]},vmin:-5,vmax:5});
test('3D coordinates place all plane orientations without swapping axes',()=>{const t=buildTraces(data(),state(),colors);assert.deepEqual(t[0].x,[[30,40],[30,40]]);assert.deepEqual(t[0].y,[[12,12],[12,12]]);assert.deepEqual(t[0].z,[[200,200],[204,null]]);assert.deepEqual(t[1].x,[[33,33],[33,33]]);assert.deepEqual(t[1].y,[[30,40],[30,40]]);assert.deepEqual(t[2].y,[[200,200],[204,204]]);assert.deepEqual(t[2].z,[[800,800],[800,null]]);assert.ok(t.every(p=>p.cmin===-5&&p.cmax===5&&p.opacity===.8))});
test('polarity and colormap reversal preserve missing cells',()=>{const v=state();v.seismic.reverse_polarity=true;v.seismic.reverse_colormap=true;const [p]=buildTraces(data(),v,colors);assert.deepEqual(p.surfacecolor,[[-1,-2],[-3,null]]);assert.deepEqual(p.colorscale,[[0,'#ffffff'],[1,'#000000']])});
test('exports preserve physical ranges and camera with independent visibility',()=>{const v=state(),d=data();const layout=buildLayout(d,v,'orbit',{background:'#aabbcc',show_axes:false,show_axis_labels:false});assert.deepEqual(layout.scene.zaxis.range,[1200,200]);assert.deepEqual(layout.scene.xaxis.range,[30,40]);assert.deepEqual(layout.scene.camera,v.scene.camera);assert.notEqual(layout.scene.camera,v.scene.camera);assert.equal(layout.scene.xaxis.visible,false);assert.equal(layout.scene.xaxis.title.text,'');assert.equal(layout.paper_bgcolor,'#aabbcc');assert.equal(layout.scene.aspectratio.z,.7);assert.equal(buildTraces(d,v,colors,{show_bounding_box:true}).length,4)});
test('visibility omits hidden planes immediately, including their borders',()=>{const v=state();v.slices.inline[0].visible=false;assert.equal(buildTraces(data(),v,colors).length,2)});
test('intersection foreground and outline have distinct depth layers without moving data or inflating widths',()=>{
  const v=state(),d=data();
  v.horizons=[{id:'h',name:'H',visible:true,display_mode:'slice_intersections',color:'#ff0000',opacity:1,line:{visible:true,style:'solid',width:1},outline:{enabled:true,width:.5},marker:{visible:false,shape:'none',size:2}}];
  const pts={slice_id:'inline',kind:'inline',x:[30,null,40],y:[12,null,12],z:[300,null,350]};
  d.horizons.h={intersections:[pts]};
  const [outline,foreground]=buildTraces(d,v,colors).slice(-2);
  assert.equal(outline.meta.depthLayer,1);assert.equal(foreground.meta.depthLayer,2);
  assert.deepEqual(foreground.x,pts.x);assert.deepEqual(foreground.y,pts.y);assert.deepEqual(foreground.z,pts.z);
  assert.equal(foreground.line.width,4/3);assert.equal(outline.line.width,8/3);
});
test('depth adapter biases each draw and restores GL state even after errors',async()=>{
  const src=await readFile(new URL('../src/components/SeismicViewer3D/depthLayers.ts',import.meta.url),'utf8');
  const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  const {applyDepthLayers}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
  let enabled=false,factor=0,units=0,draws=0;
  const gl={POLYGON_OFFSET_FILL:1,POLYGON_OFFSET_FACTOR:2,POLYGON_OFFSET_UNITS:3,isEnabled:()=>enabled,getParameter:k=>k===2?factor:units,enable:()=>enabled=true,disable:()=>enabled=false,polygonOffset:(f,u)=>{factor=f;units=u}};
  const object={draw(){draws++;assert.equal(enabled,true);assert.equal(factor,-2);assert.equal(units,-8)},drawTransparent(){throw Error('draw failure')}};
  const trace={data:{meta:{depthLayer:2}},linePlot:object};
  const el={_fullLayout:{scene:{_scene:{traces:{h:trace},glplot:{gl,redraw(){}}}}}};
  applyDepthLayers(el);applyDepthLayers(el);object.draw();assert.equal(draws,1);
  assert.equal(enabled,false);assert.equal(factor,0);assert.equal(units,0);
  assert.throws(()=>object.drawTransparent(),/draw failure/);assert.equal(enabled,false);assert.equal(units,0);
});
test('surface colors use independent native TWT ranges and stay separate from seismic',()=>{
  const v=state(),d=data();
  const mesh=(lo,hi)=>({x:[30,40,30],y:[10,10,12],z:[lo,lo,hi],scalar:[lo,lo,hi],twt_range:[lo,hi],i:[0],j:[1],k:[2],edges:[]});
  v.horizons=['a','b'].map(id=>({id,name:id,visible:true,display_mode:'full_surface',surface_mode:'surface',color:'#123456',opacity:1,color_by:'twt',smooth_shading:true,lighting:true}));
  d.horizons={a:{mesh:mesh(400,500)},b:{mesh:mesh(700,900)}};
  const [a,b]=buildTraces(d,v,colors).filter(t=>t.type==='mesh3d');
  assert.deepEqual([a.cmin,a.cmax,b.cmin,b.cmax],[400,500,700,900]);
  assert.deepEqual(a.intensity,[400,400,500]);assert.deepEqual(a.colorscale,b.colorscale);
  assert.equal(a.colorscale[0][1],'#ff0000');assert.equal(a.colorscale.at(-1)[1],'#ff00ff');
  assert.equal(a.flatshading,false);assert.equal(a.lighting.ambient,.8);assert.equal(a.lighting.diffuse,.2);
  // Across all surface slopes, lighting retains 80–100% of base RGB.
  for (const cosine of [-1, 0, .5, 1]) {
    const brightness=Math.min(a.lighting.ambient+a.lighting.diffuse*Math.max(cosine,0),1);
    assert.ok(brightness>=.8 && brightness<=1);
  }
  assert.equal(a.lighting.specular,.05);
  assert.deepEqual(a.lightposition,{x:0,y:0,z:-1});
  v.horizons[0].color_by='solid';v.horizons[0].smooth_shading=false;v.horizons[0].lighting=false;
  const solid=buildTraces(d,v,colors).find(t=>t.type==='mesh3d');
  assert.equal(solid.color,'#123456');assert.equal(solid.intensity,undefined);
  assert.equal(solid.flatshading,true);assert.equal(solid.lighting.ambient,1);assert.equal(solid.lighting.diffuse,0);
  d.horizons.b.mesh=mesh(700,700);
  const flat=buildTraces(d,v,colors).filter(t=>t.type==='mesh3d')[1];
  assert.ok(flat.cmin<700&&flat.cmax>700);assert.equal((700-flat.cmin)/(flat.cmax-flat.cmin),.5);
});
