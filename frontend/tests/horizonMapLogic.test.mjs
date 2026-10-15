import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/components/horizonMapLogic.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { mapPresentation, mapSelectionError, profileEndpointError, profileRequestKey, profileProbeRequest, profileHorizonStyleKey, profileContainerViewport, profileAspectPair, mapViewForKey } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const horizons = [{ id: 'r', name: '参考' }, { id: 'c', name: '对比' }];

test('section sizing rejects hidden/unmeasured containers and reserves axes and A/B labels', () => {
  assert.equal(profileContainerViewport(0, 600), null);
  assert.equal(profileContainerViewport(800, 0), null);
  assert.equal(profileContainerViewport(NaN, 600), null);
  assert.deepEqual(profileContainerViewport(1000, 700), { width: 904, height: 616 });
  assert.deepEqual(profileContainerViewport(90, 80), { width: 8, height: 8 });
});

test('tab keyboard navigation selects only map or section', () => {
  assert.equal(mapViewForKey('map', 'ArrowRight'), 'section');
  assert.equal(mapViewForKey('section', 'ArrowLeft'), 'map');
  assert.equal(mapViewForKey('map', 'End'), 'section');
  assert.equal(mapViewForKey('section', 'Home'), 'map');
  assert.equal(mapViewForKey('map', 'Escape'), null);
});

test('fixed profile ratios measure the actual drawing area for sampling and tab restoration', () => {
  assert.deepEqual(profileContainerViewport(1000, 700, 2), { width: 904, height: 452 });
  assert.deepEqual(profileContainerViewport(1000, 700, .5), { width: 308, height: 616 });
  assert.deepEqual(profileContainerViewport(1000, 700, 1), { width: 616, height: 616 });
  assert.deepEqual(profileContainerViewport(1000, 700, null), { width: 904, height: 616 });
});

test('one scalar ratio reaches the existing export API without violating component bounds', () => {
  assert.equal(profileAspectPair(null), null);
  for (const ratio of [.02, .5, 1, 2, 3, 50]) {
    const pair = profileAspectPair(ratio);
    assert.ok(pair.every(n => n >= .1 && n <= 5));
    assert.ok(Math.abs(pair[0] / pair[1] - ratio) < 1e-10);
  }
});

test('switching views preserves the profile cache key and independent saved axes', () => {
  const state = { horizon: 'r', x_range: [10, 20], y_range: [30, 40] };
  const seismic = { background_interpolation: true, wiggle_interpolation: true };
  const args = ['h', [1, 2], [3, 4], seismic, { width: 904, height: 616 }, [2, 8], [200, 400]];
  const key = profileRequestKey(state, ...args);
  for (const activeView of ['map', 'section', 'map', 'section'])
    assert.equal(profileRequestKey({ ...state, activeView, x_range: [12, 15], y_range: [32, 35] }, ...args), key);
});

test('difference direction, absolute bars and units stay consistent with the calculated scalar', () => {
  const state = { horizon: 'r', color_by: 'difference', difference_reference: 'r', difference_comparison: 'c', difference_type: 'signed' };
  assert.deepEqual(mapPresentation(state, horizons), { title: '层位差值 · 对比 − 参考', scalar: 'ΔTime', unit: 'ms' });
  assert.deepEqual(mapPresentation({ ...state, difference_type: 'absolute' }, horizons), { title: '层位差值 · |对比 − 参考|', scalar: '|ΔTime|', unit: 'ms' });
  assert.match(mapPresentation({ ...state, difference_comparison: null }, horizons).title, /请选择对比层位/);
});

test('amplitude readings do not inherit time units', () => {
  assert.deepEqual(mapPresentation({ horizon: 'r', color_by: 'amplitude' }, horizons), { title: '沿层振幅 · 参考', scalar: '振幅', unit: '' });
  assert.equal(mapPresentation({ horizon: 'r', color_by: 'twt' }, horizons).unit, 'ms');
});

test('incomplete picking, coincident endpoints and invalid coordinates are distinguished', () => {
  assert.equal(profileEndpointError(null, [1, 2]), '');
  assert.match(profileEndpointError([1, 2], [1, 2]), /不能重合/);
  assert.match(profileEndpointError([NaN, 2], [1, 3]), /有效数字/);
  assert.equal(profileEndpointError([1, 2], [1, 3]), '');
});

test('missing and identical comparison members cannot render a misleading result', () => {
  const state = { horizon: 'r', color_by: 'difference', difference_reference: 'r', difference_comparison: 'c' };
  assert.equal(mapSelectionError(state, horizons), '');
  assert.match(mapSelectionError({ ...state, difference_reference: null }, horizons), /请选择已加载/);
  assert.match(mapSelectionError({ ...state, difference_comparison: 'r' }, horizons), /不能相同/);
  assert.match(mapSelectionError(state, [horizons[0]]), /需要两个不同层位/);
  assert.match(mapSelectionError(state, []), /导入或选择/);
});

test('map color and display edits preserve the current A–B raster', () => {
  const state = { horizon: 'r', color_by: 'twt', colormap: 'petrel', colorbar: true };
  const seismic = { adaptive_resolution: true, interpolation: 'bilinear', colormap: 'seismic', reverse_colormap: false };
  const key = profileRequestKey(state, 'loaded-horizons', [1, 2], [3, 4], seismic);
  for (const color_by of ['twt', 'amplitude', 'difference']) {
    assert.equal(profileRequestKey({ ...state, color_by, colormap: 'viridis', colorbar: false }, 'loaded-horizons', [1, 2], [3, 4], { ...seismic, colormap: 'gray', reverse_colormap: true }), key);
  }
});

test('geometry and sampling edits invalidate the A–B raster', () => {
  const state = { horizon: 'r' };
  const seismic = { background_interpolation: true, wiggle_interpolation: true, wiggle: false, variable_area: false };
  const key = profileRequestKey(state, 'loaded-horizons', [1, 2], [3, 4], seismic);
  assert.notEqual(profileRequestKey({ horizon: 'c' }, 'loaded-horizons', [1, 2], [3, 4], seismic), key);
  assert.notEqual(profileRequestKey(state, 'changed-horizons', [1, 2], [3, 4], seismic), key);
  assert.notEqual(profileRequestKey(state, 'loaded-horizons', [2, 2], [3, 4], seismic), key);
  assert.notEqual(profileRequestKey(state, 'loaded-horizons', [1, 2], [3, 5], seismic), key);
  assert.notEqual(profileRequestKey(state, 'loaded-horizons', [1, 2], [3, 4], { ...seismic, background_interpolation: false }), key);
  assert.notEqual(profileRequestKey(state, 'loaded-horizons', [1, 2], [3, 4], { ...seismic, wiggle_interpolation: false }), key);
});

test('profile style invalidation excludes visibility but retains actual curve styling', () => {
  const h = { id: 'h', name: 'H', visible: true, color: '#123456',
    line: { visible: true, width: 1, style: 'solid' },
    marker: { visible: false, size: 3, shape: 'circle' }, outline: { enabled: true, width: .5 } };
  const key = profileHorizonStyleKey([h]);
  assert.equal(profileHorizonStyleKey([{ ...h, visible: false }]), key);
  for (const patch of [{color:'#ff0000'}, {name:'Renamed'}, {line:{...h.line,width:2}},
    {marker:{...h.marker,visible:true}}, {outline:{...h.outline,enabled:false}}])
    assert.notEqual(profileHorizonStyleKey([{...h,...patch}]), key);
});

 test('independent overlay, amplitude, viewport and visible-range changes invalidate the profile', () => {
   const state={horizon:'r'}, s={background_interpolation:true,wiggle_interpolation:true,wiggle:false,variable_area:false,wiggle_gain:1,clip_mode:'percentile',clip_percentile:99.5,reverse_polarity:false};
   const key=profileRequestKey(state,'h',[1,2],[3,4],s,{width:300,height:200},null,null);
   for (const patch of [{wiggle:true},{variable_area:true},{wiggle_gain:2},{clip_percentile:90},{reverse_polarity:true}])
     assert.notEqual(profileRequestKey(state,'h',[1,2],[3,4],{...s,...patch},{width:300,height:200},null,null),key);
   assert.notEqual(profileRequestKey(state,'h',[1,2],[3,4],s,{width:600,height:200},null,null),key);
   assert.notEqual(profileRequestKey(state,'h',[1,2],[3,4],s,{width:300,height:200},[2,3],[200,400]),key);
   assert.equal(profileRequestKey(state,'h',[1,2],[3,4],{...s,interpolation:'bicubic',adaptive_resolution:false},{width:300,height:200},null,null),key);
 });

 test('profile amplitude queries map distance and TWT back to original survey coordinates',()=>{
   const profile={x_range:[0,200],path_start:[100,200],path_end:[150,400]};
   assert.deepEqual(profileProbeRequest(profile,{x:50,y:300}),{kind:'inline',position:112.5,crossline:250,time:300});
   assert.deepEqual(profileProbeRequest(profile,{x:-1,y:300}),{kind:'inline',position:100,crossline:200,time:300});
   assert.equal(profileProbeRequest(profile,{x:NaN,y:300}),null);
 });
