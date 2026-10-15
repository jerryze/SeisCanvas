import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64');
const junctionURL = moduleURL(await readFile(new URL('../src/components/SeismicViewer3D/axisJunctions.ts', import.meta.url), 'utf8'));
const uniformURL = moduleURL(await readFile(new URL('../src/components/SeismicViewer3D/shaderUniforms.ts', import.meta.url), 'utf8'));
const source = (await readFile(new URL('../src/components/SeismicViewer3D/vectorAxes.ts', import.meta.url), 'utf8'))
  .replace('"./axisJunctions"', JSON.stringify(junctionURL)).replace('"./shaderUniforms"',JSON.stringify(uniformURL));
const { projectGlyph, projectLineVertex, captureVectorAxes, translateVectorOverlay, clipToViewport } = await import(moduleURL(source));
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const uniforms = () => ({
  model: identity(), view: identity(), projection: identity(),
  resolution: [800, 600], screenShape: [800, 600], offset: [0, 0, 0],
  axis: [1, 0, 0], alignDir: [0, 1, 0], alignOpt: [-1, 0.5, 0],
  scale: 10, pixelScale: 2, angle: 0, color: new Float32Array([0, 0, 0, 1]),
  majorAxis: [0, 0, 0], minorAxis: [1, 0, 0], screenAxis: [0, 1, 0], lineWidth: 4,
});

test('glyph vectors preserve original anchor, native pixel scale and Time title rotation', () => {
  const u = uniforms();
  assert.deepEqual(projectGlyph([0.5, 0.25, 0.2], u), [490, 295]);
  u.axis = [0, 0, 0];
  u.alignOpt = [1, 0.5, 1];
  const title = projectGlyph([1, 0, 0], u);
  assert.ok(Math.abs(title[0] - 400) < 1e-10);
  assert.ok(Math.abs(title[1] - 280) < 1e-10);
  u.angle = Math.PI;
  assert.ok(Math.abs(projectGlyph([1, 0, 0], u)[1] - 320) < 1e-10);
  u.offset = [0, 0, 2];
  assert.equal(projectGlyph([1, 0, 0], u), null);
});

test('line triangles use the pinned shader NDC offset and output-pixel width', () => {
  const u = uniforms();
  assert.deepEqual(projectLineVertex([0, 0, 1], u), [400, 299]);
  assert.deepEqual(projectLineVertex([0, 0, -1], u), [400, 301]);
  assert.deepEqual(projectLineVertex([0, 1, 1], u), [800, 299]);
});

test('viewport clipping retains a partial glyph and omits fully offscreen glyphs', () => {
  const polygon = clipToViewport([[-10, 10], [20, 10], [20, 40]], 100, 80);
  assert.equal(polygon.length, 4);
  assert.ok(polygon.every(([x, y]) => x >= 0 && x <= 100 && y >= 0 && y <= 80));
  assert.deepEqual(clipToViewport([[-30, 10], [-20, 10], [-20, 40]], 100, 80), []);
});

function axesFixture() {
  const drawCalls = [];
  const buffer = { update() {} };
  const text = {
    shader: { uniforms: uniforms() }, buffer,
    vao: { draw() { drawCalls.push('text'); } },
    tickOffset: [0, 0, 0], tickCount: [3, 0, 0], labelOffset: [3, 3, 3], labelCount: [0, 0, 3],
    update() { buffer.update([0, 0, 0.25, 0.5, 0, 0.25, 0, 0.5, 0.25, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0]); },
    drawTicks() { this.vao.draw(4, this.tickCount[0], this.tickOffset[0]); },
    drawLabel() { this.vao.draw(4, this.labelCount[2], this.labelOffset[2]); },
  };
  const lines = {
    shader: { uniforms: uniforms() }, vao: { draw() { drawCalls.push('line'); } },
    tickOffset: [6, 18, 18], tickCount: [6, 0, 0], gridOffset: [12, 18, 18], gridCount: [6, 0, 0],
    drawAxisLine() { this.vao.draw(4, 6); }, drawAxisTicks() { this.vao.draw(4, 6, 6); },
    drawGrid() { this.vao.draw(4, 6, 12); }, drawZero() { this.vao.draw(4, 6); },
  };
  const axes = {
    _text: text, _lines: lines, bounds: [[0, 0, 0], [1, 1, 1]],
    labels: ['Crossline', 'Inline', 'Time (ms)'], labelEnable: [true, true, true], tickEnable: [true, true, true],
    ticks: [[{ x: 0.25, text: '25' }], [], []], update() {},
  };
  for (const prefix of ['label', 'tick']) {
    axes[prefix + 'Font'] = ['Arial', 'Arial', 'Arial'];
    axes[prefix + 'FontStyle'] = ['normal', 'normal', 'normal'];
    axes[prefix + 'FontWeight'] = ['normal', 'normal', 'normal'];
    axes[prefix + 'FontVariant'] = ['normal', 'normal', 'normal'];
  }
  return { axes, drawCalls };
}

test('native axes draws become bounded vectors with separate foreground and back-grid layers', () => {
  const { axes, drawCalls } = axesFixture();
  const original = { update: axes.update, upload: axes._text.buffer.update, text: axes._text.vao.draw, line: axes._lines.vao.draw, grid: axes._lines.drawGrid };
  const adapter = captureVectorAxes(axes);
  axes._text.drawTicks(); axes._text.drawLabel(); axes._lines.drawGrid(); axes._lines.drawAxisLine();
  assert.deepEqual(drawCalls, []);
  assert.equal(adapter.overlay.paths.length, 6);
  assert.equal(adapter.overlay.paths.filter(path => path.layer === 'back').length, 2);
  assert.ok(adapter.overlay.paths.every(path => path.color === '#000000' && path.opacity === 1));
  assert.ok(adapter.overlay.paths.every(path => path.points.flat().every(Number.isFinite)));
  assert.deepEqual(adapter.overlay.labels, ['Crossline', 'Inline', 'Time (ms)', '25']);
  const translated = translateVectorOverlay(adapter.overlay, -20, 12);
  assert.deepEqual(translated.paths[0].points[0], [adapter.overlay.paths[0].points[0][0] - 20, adapter.overlay.paths[0].points[0][1] + 12]);
  adapter.restore();
  assert.equal(axes.update, original.update); assert.equal(axes._text.buffer.update, original.upload);
  assert.equal(axes._text.vao.draw, original.text); assert.equal(axes._lines.vao.draw, original.line);
  assert.equal(axes._lines.drawGrid, original.grid);
  axes._text.drawTicks(); axes._lines.drawGrid();
  assert.deepEqual(drawCalls, ['text', 'line']);
});

test('unsupported native renderer fails explicitly without leaving adapters installed', () => {
  const { axes } = axesFixture();
  const original = axes.update;
  delete axes._lines.vao;
  assert.throws(() => captureVectorAxes(axes), /矢量坐标/);
  assert.equal(axes.update, original);
});

 test('active GL programs supply vector uniforms without invoking broken gl-shader getters',()=>{
   const {axes}=axesFixture();
   for(const object of [axes._text,axes._lines]) {
     const values=object.shader.uniforms;
     const uniformObject={};
     for(const name of Object.keys(values)) Object.defineProperty(uniformObject,name,{get(){throw Error('broken native getter');}});
     object.shader={uniforms:uniformObject,program:{},gl:{
       getUniformLocation(_program,name){return name;},getUniform(_program,location){return values[location];}
     }};
   }
   const adapter=captureVectorAxes(axes);
   axes._text.drawTicks();axes._lines.drawGrid();axes._lines.drawAxisLine();
   assert.ok(adapter.overlay.paths.length>0);
   assert.ok(adapter.overlay.paths.every(p=>p.points.flat().every(Number.isFinite)));
   adapter.restore();
 });
