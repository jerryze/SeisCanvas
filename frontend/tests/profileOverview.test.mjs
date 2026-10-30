import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64');
const source = await readFile(new URL('../src/components/HorizonMap.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('HorizonMap.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'HorizonMap');
const effects = component.body.statements.filter(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'useEffect')
  .map(node => node.expression.arguments[0]);
const requestEffect = effects.find(node => node.getText(ast).includes('api("/horizon-map/profile"'));
const renderEffect = effects.find(node => node.getText(ast).includes('const sharedSection: Section'));
const declarations = component.body.statements.filter(ts.isVariableStatement)
  .flatMap(node => [...node.declarationList.declarations]);
const profileData = declarations.find(node => node.name.getText(ast) === 'profileData');
const profileFresh = declarations.find(node => node.name.getText(ast) === 'profileFresh');
const profileDisplayReady = declarations.find(node => node.name.getText(ast) === 'profileDisplayReady');
const drawStatements = renderEffect.body.statements;
const first = drawStatements.findIndex(node => node.getText(ast).startsWith('const sharedSection:'));
const last = drawStatements.findIndex(node => node.getText(ast).startsWith('void renderer.render('));
const renderCall = drawStatements[last].expression.expression;
assert.ok(requestEffect && profileData && first >= 0 && last > first);

// Execute the actual component effect with mocked network/timers. Plotly and
// unrelated map controls are outside this profile request-lifecycle boundary.
const rasterModule = moduleURL(await readFile(new URL('../src/components/loadedRaster.ts', import.meta.url), 'utf8'));
const aspectModule = moduleURL(await readFile(new URL('../src/components/plotAspect.ts', import.meta.url), 'utf8'));
const logicModule = moduleURL(await readFile(new URL('../src/components/horizonMapLogic.ts', import.meta.url), 'utf8'));
const { runRequest, selectData, isFresh, isDisplayReady, completeDrawing, profileDrawing } = await import(moduleURL(`
  import { coversViewport } from ${JSON.stringify(rasterModule)};
  import { plotAspectLayout } from ${JSON.stringify(aspectModule)};
  import { PROFILE_MARGIN } from ${JSON.stringify(logicModule)};
  export const runRequest = ({ sectionActive, profileOn, profileA, profileB, endpointError, mapIssue,
    profileFresh, profileRef, plot, setProfileFailure, query, profileViewport, seismic, workspace,
    hasSeismic, profileData, profileQueryKey, profileContentKey, pathKey, setProfileResult,
    setProfileError, api }) => (${requestEffect.getText(ast)})();
  export const selectData = (profileResult, profileContentKey, endpointError = '', mapIssue = '') =>
    ${profileData.initializer.getText(ast)};
  export const isFresh = ({ profileResult, profileQueryKey, profileData, seismic, workspace,
    profileViewport, profileRef, profilePixelRatio }) => ${profileFresh.initializer.getText(ast)};
  export const isDisplayReady = (profileData, profileDrawnContentKey, profileContentKey) =>
    ${profileDisplayReady.initializer.getText(ast)};
  export function completeDrawing(profileContentKey, setProfileDrawnContentKey) {
    const profileBackdropCleanup = { current: () => {} }, profileRenderedInputs = { current: null }, inputs = [];
    const el = { on() {}, removeAllListeners() {} }, setProfileDrawn = () => {}, reportProfileViewport = () => {};
    return (${renderCall.arguments[3].getText(ast)})();
  }
  export function profileDrawing(profileData, horizons, seismic, maps, sectionTraces, buildOverviewImages) {
    const el = { clientWidth: 1000, clientHeight: 700 }, workspace = { profileDrag: 'zoom' };
    const frame = plotAspectLayout(el.clientWidth, el.clientHeight, PROFILE_MARGIN, null);
    ${drawStatements.slice(first, last).map(node => node.getText(ast)).join('\n')}
    return { traces, layout: ${renderCall.arguments[1].getText(ast)} };
  }
`));
const { profileRequestKey } = await import(logicModule);
const { createProfilePlotRenderer } = await import(moduleURL(await readFile(new URL('../src/components/profilePlotRenderer.ts', import.meta.url), 'utf8')));
const settled = () => new Promise(resolve => setImmediate(resolve));
const makeOverview = () => ({ x: [0, 100], time: [0, 200], x_edges: [-.5, 50, 100.5],
  time_edges: [-.5, 100, 200.5], raster_extent: [-.5, 100.5, -.5, 200.5], z: [[-5, null], [2, 8]] });
const makeProfile = patch => ({ has_seismic: true, distance: [40, 60], time: [90, 110],
  amplitude: [[1, 2], [3, null]], distance_edges: [39.5, 50, 60.5], time_edges: [89.5, 100, 110.5],
  raster_extent: [39.5, 60.5, 89.5, 110.5], curves: [], curve_distance: [],
  x_range: [0, 100], time_range: [0, 200], a_distance: 25, b_distance: 75, label_y: 'Time (ms)',
  vmin: -10, vmax: 10, background_interpolation: true, ...patch });

async function withHarness(run) {
  const saved = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, window: globalThis.window };
  let next = 0;
  const h = { requests: [], timers: new Map(), errors: [], result: null, cleanup: null,
    props: { state: { horizon: 'h' }, horizonKey: 'h', profileA: [1, 2], profileB: [3, 4],
      seismic: { background_interpolation: true, wiggle: false, variable_area: false },
      workspace: { profileXRange: null, profileTimeRange: null }, hasSeismic: true } };
  globalThis.window = { devicePixelRatio: 2 };
  globalThis.setTimeout = (callback, delay) => { h.timers.set(++next, { callback, delay }); return next; };
  globalThis.clearTimeout = id => h.timers.delete(id);
  h.render = (patch = {}) => {
    h.cleanup?.(); h.props = { ...h.props, ...patch };
    const { state, horizonKey, profileA, profileB, seismic, workspace } = h.props;
    const contentKey = profileRequestKey(state, horizonKey, profileA, profileB, seismic, null);
    h.data = selectData(h.result, contentKey);
    h.cleanup = runRequest({ ...h.props, sectionActive: true, profileOn: false,
      endpointError: '', mapIssue: '', profileFresh: false, profileData: h.data,
      profileRef: { current: { clientWidth: 800, clientHeight: 500 } }, plot: { current: null },
      profileViewport: { width: 704, height: 416 }, query: JSON.stringify(state),
      profileContentKey: contentKey, pathKey: JSON.stringify([profileA, profileB]),
      profileQueryKey: profileRequestKey(state, horizonKey, profileA, profileB, seismic,
        { width: 704, height: 416 }, workspace.profileXRange, workspace.profileTimeRange),
      setProfileFailure: () => {}, setProfileError: message => h.errors.push(message),
      setProfileResult: update => { h.result = typeof update === 'function' ? update(h.result) : update; },
      api: (path, init) => new Promise((resolve, reject) => h.requests.push({ path, init, resolve, reject })),
    });
  };
  h.advance = () => {
    for (const [id, { callback, delay }] of h.timers) {
      assert.equal(delay, 250); h.timers.delete(id); void callback();
    }
  };
  h.complete = async (index, data) => { h.requests[index].resolve({ json: async () => data }); await settled(); };
  h.body = index => JSON.parse(h.requests[index].init.body);
  try { h.render(); await run(h); }
  finally { h.cleanup?.(); Object.assign(globalThis, saved); }
}

test('A–B requests one uncolored overview and retains it across viewport resampling', () => withHarness(async h => {
  h.advance();
  assert.equal(h.body(0).include_overview, true);
  assert.deepEqual([h.body(0).target_width, h.body(0).target_height], [1408, 832]);
  const overview = makeOverview(), first = makeProfile({ overview });
  await h.complete(0, first);
  assert.equal(h.result.data.overview, overview);
  assert.equal(h.result.data.amplitude, first.amplitude);
  h.render({ workspace: { profileXRange: [70, 90], profileTimeRange: [100, 120] } });
  assert.equal(h.data.overview, overview, 'the full-path data remains available while panning');
  h.advance();
  assert.equal(h.body(1).include_overview, false);
  const detail = makeProfile({ vmin: -20, vmax: 30 });
  await h.complete(1, detail);
  assert.equal(h.result.data.overview, overview);
  assert.equal(h.result.data.amplitude, detail.amplitude);
  assert.deepEqual([h.result.data.vmin, h.result.data.vmax], [-20, 30]);
  assert.equal(Object.hasOwn(overview, 'vmin'), false, 'only the accepted detail determines color limits');
}));

test('A–B path and scientific settings changes discard the old overview', () => withHarness(async h => {
  h.advance(); await h.complete(0, makeProfile({ overview: makeOverview() }));
  h.render({ profileB: [8, 9] });
  assert.equal(h.data, null);
  h.advance(); assert.equal(h.body(1).include_overview, true);
  await h.complete(1, makeProfile());
  assert.equal(h.result.data.overview, undefined);
  const replacement = makeOverview();
  h.render(); h.advance(); await h.complete(2, makeProfile({ overview: replacement }));
  h.render({ seismic: { ...h.props.seismic, reverse_polarity: true } });
  assert.equal(h.data, null);
  h.advance(); assert.equal(h.body(3).include_overview, true);
  await h.complete(3, makeProfile());
  assert.equal(h.result.data.overview, undefined);
}));

test('A–B display-only colors retain the same overview while pending old requests cannot replace it', () => withHarness(async h => {
  h.advance();
  h.render({ workspace: { profileXRange: [20, 40], profileTimeRange: null } });
  assert.equal(h.requests[0].init.signal.aborted, true);
  h.advance();
  const accepted = makeOverview();
  await h.complete(1, makeProfile({ overview: accepted }));
  await h.complete(0, makeProfile({ overview: makeOverview() }));
  assert.equal(h.result.data.overview, accepted);
  h.render({ seismic: { ...h.props.seismic, colormap: 'gray', reverse_colormap: true } });
  assert.equal(h.data.overview, accepted);
  h.advance(); assert.equal(h.body(2).include_overview, false);
}));

test('horizon-only A–B sections never request or retain seismic overviews', () => withHarness(async h => {
  h.render({ hasSeismic: false }); h.advance();
  assert.equal(h.body(0).include_overview, false);
  await h.complete(0, makeProfile({ has_seismic: false, overview: makeOverview() }));
  assert.equal(h.result.data.overview, undefined);
}));

test('A–B cleanup ignores late responses and incompatible interpolation never enters retained data', () => withHarness(async h => {
  h.advance(); await h.complete(0, makeProfile({ background_interpolation: false, overview: makeOverview() }));
  assert.equal(h.result, null);
  assert.match(h.errors[0], /后端版本不匹配/);
  h.render(); h.advance(); h.cleanup();
  await h.complete(1, makeProfile({ overview: makeOverview() }));
  assert.equal(h.result, null);
}));

test('A–B renders navigation images under the detailed traces with current raw data and colors', () => {
  const data = makeProfile({ overview: makeOverview() });
  const detail = { type: 'heatmap' };
  const images = [{ source: 'data:image/png;base64,preview', layer: 'below', xref: 'x', yref: 'y' }];
  const seismic = { colormap: 'gray', reverse_colormap: true, reverse_polarity: true }, colors = [[0, '#000'], [1, '#fff']];
  let received, imageInputs;
  const { traces, layout } = profileDrawing(data, [], seismic, { gray: colors }, section => {
    received = section; return [detail];
  }, (section, view, scale) => {
    imageInputs = [section, view, scale]; return images;
  });
  assert.equal(received.overview, data.overview);
  assert.equal(received.z, data.amplitude);
  assert.deepEqual([received.vmin, received.vmax], [data.vmin, data.vmax]);
  assert.equal(imageInputs[0], received);
  assert.equal(imageInputs[1].seismic, seismic);
  assert.equal(imageInputs[2], colors);
  assert.equal(layout.images, images);
  assert.equal(traces.length, 1, 'navigation images never become hover traces');
  assert.match(traces[0].hovertemplate, /距离/);
  assert.deepEqual(layout.xaxis.range, data.x_range);
  assert.deepEqual(layout.yaxis.range, [...data.time_range].reverse());
});

test('covered A–B interpolation still resamples shifted centres; only native cells reuse coverage', () => {
  const data = makeProfile({ raster_extent: [0, 100, 0, 200], preview_shape: [2000, 2000],
    x_range: [0, 100], time_range: [0, 200] });
  const context = { profileResult: { key: 'initial' }, profileQueryKey: 'shifted-viewport', profileData: data,
    seismic: { background_interpolation: true, wiggle: false, variable_area: false },
    workspace: { profileXRange: [20.25, 60.25], profileTimeRange: [50.25, 150.25] },
    profileViewport: { width: 100, height: 100 }, profileRef: { current: null }, profilePixelRatio: 1 };
  assert.equal(isFresh(context), false, 'a dense older grid is not the requested sinc sampling phase');
  assert.equal(isFresh({ ...context, profileQueryKey: 'initial' }), true);
  const native = { ...context, seismic: { ...context.seismic, background_interpolation: false } };
  assert.equal(isFresh(native), true);
  for (const overlay of ['wiggle', 'variable_area'])
    assert.equal(isFresh({ ...native, seismic: { ...native.seismic, [overlay]: true } }), false);
  assert.equal(isFresh({ ...native, workspace: { ...native.workspace, profileXRange: [90, 110] } }), false);
});

test('new A–B data stays hidden until its own plot completes while same-source navigation remains visible', async () => {
  const data = makeProfile(), state = { horizon: 'h' }, seismic = { background_interpolation: true };
  const key = (a, b) => profileRequestKey(state, 'loaded-horizons', a, b, seismic, null);
  const oldKey = key([1, 2], [3, 4]), nextKey = key([1, 2], [8, 9]);
  let drawnKey = oldKey, finish;
  const renderer = createProfilePlotRenderer({
    react: () => new Promise(resolve => { finish = resolve; }),
    restyle: async () => {}, relayout: async () => {}, purge() {},
  }, {}, error => assert.fail(error));
  assert.equal(isDisplayReady(data, drawnKey, oldKey), true);
  assert.equal(isDisplayReady(null, drawnKey, nextKey), false, 'the next path is hidden while its data loads');
  const drawing = renderer.render([{ type: 'heatmap' }], {}, {}, () => completeDrawing(nextKey, value => { drawnKey = value; }));
  await settled();
  assert.equal(isDisplayReady(data, drawnKey, nextKey), false, 'new data cannot reveal the old SVG before Plotly finishes');
  finish(); await drawing;
  assert.equal(isDisplayReady(data, drawnKey, nextKey), true);
  const refined = makeProfile({ raster_extent: [70, 80, 100, 120] });
  const refinement = renderer.render([{ type: 'heatmap' }], {}, {}, () => completeDrawing(nextKey, value => { drawnKey = value; }));
  await settled();
  assert.equal(isDisplayReady(refined, drawnKey, nextKey), true, 'a new viewport of the drawn source keeps its transition visible');
  finish(); await refinement;
  await renderer.dispose();
});

test('failed new-source drawing and late old-source completion never expose an old path', async () => {
  const data = makeProfile();
  let drawnKey = 'old-path';
  const errors = [];
  const renderer = createProfilePlotRenderer({
    react: async () => { throw new Error('drawing unavailable'); },
    restyle: async () => {}, relayout: async () => {}, purge() {},
  }, {}, error => errors.push(error));
  await renderer.render([{ type: 'heatmap' }], {}, {}, () => completeDrawing('new-path', value => { drawnKey = value; }));
  assert.equal(isDisplayReady(data, drawnKey, 'new-path'), false);
  assert.match(errors[0], /drawing unavailable/);
  completeDrawing('old-path', value => { drawnKey = value; });
  assert.equal(isDisplayReady(data, drawnKey, 'new-path'), false, 'late old completion cannot authorize current content');
  assert.equal(isDisplayReady(data, null, 'old-path'), false, 'a remounted data source has no completed drawing identity');
  await renderer.dispose();
});
