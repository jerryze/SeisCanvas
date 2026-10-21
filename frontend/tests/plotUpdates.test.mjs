import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const url = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText).toString('base64');
const react = url('export const useEffect=()=>{}, useId=()=>{}, useRef=()=>{}, useState=()=>{};');
const plotly = url(`export default {
  react: (...args) => globalThis.plotUpdateTest.react(...args),
  relayout: (...args) => globalThis.plotUpdateTest.relayout(...args),
};`);
const math = url(await readFile(new URL('../src/components/plotScrollMath.ts', import.meta.url), 'utf8'));
const loaded = url(await readFile(new URL('../src/components/loadedRaster.ts', import.meta.url), 'utf8'));
const source = (await readFile(new URL('../src/components/PlotScrollFrame.tsx', import.meta.url), 'utf8'))
  .replace('"react"', JSON.stringify(react)).replace('"plotly.js-dist-min"', JSON.stringify(plotly))
  .replace('"./plotScrollMath"', JSON.stringify(math)).replace('"./loadedRaster"', JSON.stringify(loaded))
  .replace('import "./plotScrollFrame.css";', '');
const { updatePlotData, updatePlotLayout, isScrollPreview } = await import(url(source));

test('programmatic data/layout updates suppress feedback while unchanged ranges are skipped', async () => {
  const el = { _fullLayout: { xaxis: { range: [10, 20] } } };
  let layouts = 0;
  globalThis.plotUpdateTest = {
    async react(plot) { assert.equal(isScrollPreview(plot), true); },
    async relayout(plot, patch) {
      assert.equal(isScrollPreview(plot), true);
      patch['xaxis.range'][0] = 999;
      layouts++;
    },
  };
  try {
    await updatePlotData(el, [], {}, {});
    assert.equal(isScrollPreview(el), false);
    await updatePlotLayout(el, { 'xaxis.range': [10, 20] });
    assert.equal(layouts, 0);
    const range = [12, 22];
    await updatePlotLayout(el, { 'xaxis.range': range });
    assert.equal(layouts, 1);
    assert.deepEqual(range, [12, 22]);
    assert.equal(isScrollPreview(el), false);
  } finally { delete globalThis.plotUpdateTest; }
});

test('overlapping updates and rejected renders cannot leave feedback disabled', async () => {
  const el = { _fullLayout: {} };
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  globalThis.plotUpdateTest = {
    async react() { await pending; throw new Error('render failed'); },
    async relayout() {},
  };
  try {
    const rendering = updatePlotData(el, [], {}, {});
    await updatePlotLayout(el, { dragmode: 'pan' });
    assert.equal(isScrollPreview(el), true, 'the data render is still active');
    const rejected = assert.rejects(rendering, /render failed/);
    release();
    await rejected;
    assert.equal(isScrollPreview(el), false);
  } finally { delete globalThis.plotUpdateTest; }
});
