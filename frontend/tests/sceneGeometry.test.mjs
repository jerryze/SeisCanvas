import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
let source=await readFile(new URL('../src/components/SeismicViewer3D/sceneGeometry.ts',import.meta.url),'utf8');
const styleSource = await readFile(new URL('../src/components/plotStyle.ts', import.meta.url), 'utf8');
const styleModule = ts.transpileModule(styleSource, {compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
source = source.replace('"../plotStyle"', JSON.stringify('data:text/javascript;base64,' + Buffer.from(styleModule).toString('base64')));
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {buildTraces,buildLayout,variableAreaMesh,wiggleCoordinates}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
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
test('interactive scenes can cache an invisible bounding-box actor for export without changing other traces',()=>{
  const v=state(),d=data();
  const traces=buildTraces(d,v,colors,undefined,true);
  assert.equal(traces.length,4);
  assert.equal(traces.at(-1).meta.exportRole,'boundingBox');
  assert.equal(traces.at(-1).meta.interactiveVisible,false);
});

 test('seismic cells map reconstructed amplitudes to constant face colors and native physical boundaries',()=>{
   const d=data(),v=state();d.slices=[{...plane('inline',12),a_edges:[25,35,45],b_edges:[198,202,206]}];
   const [p]=buildTraces(d,v,colors);
   assert.equal(p.type,'mesh3d');assert.equal(p.flatshading,true);
   assert.deepEqual(p.x,[25,35,45,25,35,45,25,35,45]);
   assert.deepEqual(p.y,Array(9).fill(12));assert.deepEqual(p.z,[198,198,198,202,202,202,206,206,206]);
   assert.equal(p.i.length,6);assert.equal(p.facecolor.length,6);
   assert.equal(p.facecolor[0],p.facecolor[1]);assert.equal(p.facecolor[2],p.facecolor[3]);
   assert.equal(p.intensity,undefined);assert.equal(p.surfacecolor,undefined);
   v.seismic.reverse_polarity=true;assert.notDeepEqual(buildTraces(d,v,colors)[0].facecolor,p.facecolor);
 });
 test('variable area strips follow concave positive lobes and exact zero crossings on either vertical plane',()=>{
   for(const kind of ['inline','crossline']) {
     const p={...plane(kind,12),a_edges:[29,41],b_edges:[198,220],trace_overlay:{
       variable_area:{x:[30,32,30.2,33,30,30],time:[201,203,207,211,213,201]},
       wiggle:{x:[30,32,30.2,33,30],time:[201,203,207,211,213]}}};
     const m=variableAreaMesh(p);assert.equal(m.i.length,8);
     assert.equal(Math.min(...m.z),201);assert.equal(Math.max(...m.z),213);
     assert.ok((kind==='inline'?m.y:m.x).every(v=>v===12));
     const horizontal=kind==='inline'?m.x:m.y;
     assert.ok(horizontal.every(v=>v>=30&&v<=33));
   }
 });
 test('3D overlay visibility and layer order share 2D state without applying polarity or Gain twice',()=>{
   const d=data(),v=state();d.slices=[{...plane('crossline',33),a_edges:[29,41],b_edges:[198,220],trace_overlay:{
     variable_area:{x:[30,32,30,30],time:[200,204,208,200]},wiggle:{x:[30,32,30],time:[200,204,208]}}}];
   Object.assign(v.seismic,{wiggle:true,variable_area:true,variable_area_color:'#123456',reverse_polarity:true,wiggle_gain:20});
   const t=buildTraces(d,v,colors);assert.deepEqual(t.map(p=>p.type),['mesh3d','mesh3d','scatter3d']);
   assert.equal(t[1].color,'#123456');assert.equal(t[1].meta.depthLayer,1);assert.equal(t[2].meta.depthLayer,2);
   assert.deepEqual(t[2].x,[33,33,33]);assert.deepEqual(t[2].y,[30,32,30]);assert.deepEqual(t[2].z,[200,204,208]);
   v.seismic.variable_area=false;assert.equal(buildTraces(d,v,colors).length,2);
   v.seismic.wiggle=false;assert.equal(buildTraces(d,v,colors).length,1);
 });
 test('Wiggle clipping keeps finite-plane edges exact and never connects across an out-of-plane segment',()=>{
   const p={...plane('inline',12),a_edges:[29,41],b_edges:[198,220],trace_overlay:{wiggle:{x:[30,45,45,30],time:[200,204,208,212]}}};
   const points=wiggleCoordinates(p);
   assert.ok(points.filter(p=>p[0]!==null).every(p=>p[0]>=29&&p[0]<=41));
   assert.equal(points.filter(p=>p[0]===null).length,1);
   assert.ok(points.some(p=>p[0]===41&&Math.abs(p[2]-(200+44/15))<1e-8));
 });

test('toggling overlays preserves each slice, border and horizon GPU identity and seismic colors',()=>{
  const d=data(),v=state();
  d.slices=d.slices.map(p=>({...p,a_edges:[25,35,45],b_edges:[198,202,206],trace_overlay:{
    variable_area:{x:[30,32,30,30],time:[200,202,204,200]},
    wiggle:{x:[30,32,30],time:[200,202,204]}}}));
  d.slices[0].id=v.slices.inline[0].id='Inline / 线:1';
  for(const slices of Object.values(v.slices)) Object.assign(slices[0].border,{visible:true,color:'#000',width:1});
  v.horizons=[{id:'h',name:'H',visible:true,display_mode:'full_surface',color:'#123456',opacity:1,color_by:'twt'}];
  d.horizons.h={mesh:{x:[30,40,30],y:[10,10,12],z:[400,400,500],scalar:[400,400,500],
    twt_range:[400,500],i:[0],j:[1],k:[2]}};
  const baseline=buildTraces(d,v,colors,undefined,true);
  const time=baseline.find(t=>t.name==='time 800');
  const horizon=baseline.find(t=>t.name==='H');
  for(const [wiggle,variable_area] of [[true,false],[false,true],[true,true],[false,false]]) {
    Object.assign(v.seismic,{wiggle,variable_area,variable_area_color:'#000000'});
    const next=buildTraces(d,v,colors,undefined,true);
    assert.ok(next.every(t=>typeof t.uid==='string'&&t.uid.length>0));
    // Plotly also embeds UIDs in colorbar class selectors during actor removal.
    assert.ok(next.every(t=>/^[A-Za-z][A-Za-z0-9_-]*$/.test(t.uid)));
    assert.equal(new Set(next.map(t=>t.uid)).size,next.length);
    for(const previous of baseline) {
      const current=next.find(t=>t.uid===previous.uid);
      assert.ok(current,'an existing actor must survive overlay insertion/removal');
      assert.equal(current.type,previous.type);
      assert.deepEqual(current.x,previous.x);
      assert.deepEqual(current.facecolor,previous.facecolor);
      assert.deepEqual(current.intensity,previous.intensity);
    }
    const currentTime=next.find(t=>t.name==='time 800');
    assert.equal(currentTime.uid,time.uid);
    assert.notEqual(currentTime.uid,horizon.uid);
    assert.deepEqual(currentTime.facecolor,time.facecolor);
    assert.equal(currentTime.intensity,undefined);
    // Fixed-TWT planes only contain the background and their optional border.
    assert.equal(next.filter(t=>t.z?.every?.(z=>z===800)).length,2);
  }
});

test('horizon coloring changes cannot reuse a colormap texture for solid colors',()=>{
  const d=data(),v=state();
  v.horizons=[{id:'h',name:'H',visible:true,display_mode:'full_surface',color:'#123456',opacity:1,color_by:'twt'}];
  d.horizons.h={mesh:{x:[30,40,30],y:[10,10,12],z:[400,400,500],scalar:[400,400,500],
    twt_range:[400,500],i:[0],j:[1],k:[2]}};
  const twt=buildTraces(d,v,colors).find(t=>t.name==='H');
  v.horizons[0].color_by='solid';
  const solid=buildTraces(d,v,colors).find(t=>t.name==='H');
  assert.notEqual(twt.uid,solid.uid);
  assert.equal(solid.intensity,undefined);
  assert.equal(solid.color,'#123456');
  v.horizons[0].color_by='twt';
  assert.equal(buildTraces(d,v,colors).find(t=>t.name==='H').uid,twt.uid);
});

test('amplitude surfaces follow seismic colors and polarity while retaining Time geometry',()=>{
  const d=data(),v=state();
  v.horizons=[{id:'h',name:'H',visible:true,display_mode:'full_surface',color:'#123456',opacity:.6,
    color_by:'amplitude',smooth_shading:true,lighting:false}];
  const mesh={x:[30,40,30,40],y:[10,10,12,12],z:[400,410,420,430],scalar:[400,410,420,430],
    twt_range:[400,430],i:[0,0],j:[1,3],k:[3,2],amplitude:[-100,200,null,400],
    amplitude_faces:{i:[0],j:[1],k:[3]}};
  d.horizons.h={mesh};d.vmin=-300;d.vmax=300;
  const a=buildTraces(d,v,colors).find(t=>t.name==='H');
  assert.deepEqual(a.intensity,[-100,200,null,400]);
  assert.deepEqual(a.customdata,a.intensity);
  assert.deepEqual(a.z,mesh.z);assert.deepEqual(a.i,[0]);
  assert.equal(a.cmin,-300);assert.equal(a.cmax,300);assert.equal(a.opacity,.6);
  assert.deepEqual(a.colorscale,colors.seismic);assert.match(a.hovertemplate,/振幅/);
  v.seismic.reverse_polarity=true;v.seismic.reverse_colormap=true;
  const flipped=buildTraces(d,v,colors).find(t=>t.name==='H');
  assert.deepEqual(flipped.intensity,[100,-200,null,-400]);
  assert.notDeepEqual(flipped.colorscale,a.colorscale);
  assert.deepEqual(flipped.z,mesh.z);
  v.horizons[0].color_by='twt';
  const time=buildTraces(d,v,colors).find(t=>t.name==='H');
  assert.deepEqual(time.i,mesh.i);assert.deepEqual(time.intensity,mesh.scalar);
  assert.notEqual(time.uid,a.uid);
  v.horizons[0].color_by='solid';
  const solid=buildTraces(d,v,colors).find(t=>t.name==='H');
  assert.notEqual(solid.uid,a.uid);assert.equal(solid.intensity,undefined);
  v.horizons[0].color_by='amplitude';mesh.amplitude_faces={i:[],j:[],k:[]};
  assert.ok(!buildTraces(d,v,colors).some(t=>t.name==='H'));
});
