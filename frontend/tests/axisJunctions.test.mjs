import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/components/SeismicViewer3D/axisJunctions.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText;
const {overlapsAtJunction, suppressJunctionOverlaps} = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

test('only overlapping endpoint text belonging to different axes at the same corner conflicts', () => {
  const a = {axis: 0, corner: 0, box: {left: 0, right: 20, top: 0, bottom: 10}};
  assert.equal(overlapsAtJunction(a, {...a, axis: 2}), true);
  assert.equal(overlapsAtJunction(a, {...a, axis: 2, corner: 4}), false);
  assert.equal(overlapsAtJunction(a, {...a}), false);
  assert.equal(overlapsAtJunction(a, {...a, axis: 2, box: {left: 20, right: 40, top: 0, bottom: 10}}), false);
});

const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function fixture(offset = 0, fail = false) {
  const draws = [];
  const vertices = [];
  // Three tick glyphs per axis; each has one rectangle made of two triangles.
  for (let axis = 0; axis < 3; axis++)
    for (const tick of [-.5, 0, .5])
      for (const [x, y] of [[-10,-5],[10,-5],[-10,5],[-10,5],[10,-5],[10,5]])
        vertices.push(x, y, tick);
  const text = {
    buffer: {update() {}}, bind() {}, tickOffset: [0,18,36], tickCount: [18,18,18],
    gl: {drawingBufferWidth:200, drawingBufferHeight:200},
    drawTicks(axis) {
      if (fail && axis === 1) throw Error('draw failed');
      draws.push({axis, start: this.tickOffset[axis], count: this.tickCount[axis]});
    },
  };
  const axes = {_text: text, bounds: [[-.5,-.5,-.5],[.5,.5,.5]], lastCubeProps: {cubeEdges: [0,0,0]}};
  const original = {upload: text.buffer.update, bind: text.bind, draw: text.drawTicks};
  const restore = suppressJunctionOverlaps(axes);
  text.buffer.update(vertices);
  const render = () => {
    text.bind(identity, identity, identity, 1);
    text.drawTicks(0, 1, 0, [0,-.5,-.5], [0,0,0,1], [1,0,0], [0,1,0], [-1,.5,1]);
    text.drawTicks(1, 1, 0, [-.5 + offset,0,-.5], [0,0,0,1], [0,1,0], [1,0,0], [-1,.5,1]);
  };
  return {text, restore, original, draws, render};
}

test('hide one side of a shared corner while preserving middle tick vertices and original positions', () => {
  const f = fixture();
  f.render();
  assert.deepEqual(f.draws, [{axis:0,start:0,count:18}, {axis:1,start:24,count:12}]);
  assert.deepEqual(f.text.tickOffset, [0,18,36]);
  assert.deepEqual(f.text.tickCount, [18,18,18]);
  f.restore();
  assert.equal(f.text.drawTicks, f.original.draw);
  assert.equal(f.text.bind, f.original.bind);
  assert.equal(f.text.buffer.update, f.original.upload);
});

test('non-overlapping endpoints and middle labels retain the complete native draw', () => {
  const f = fixture(.45); // Endpoint overlaps a middle label, not a shared corner.
  f.render();
  assert.deepEqual(f.draws, [{axis:0,start:0,count:18}, {axis:1,start:18,count:18}]);
  f.restore();
});

test('collision state starts fresh for each frame and restores draw ranges after errors', () => {
  const f = fixture();
  f.render(); f.render();
  assert.deepEqual(f.draws.slice(0,2), f.draws.slice(2));
  f.restore();
  const failed = fixture(0, true);
  assert.throws(failed.render, /draw failed/);
  assert.deepEqual(failed.text.tickOffset, [0,18,36]);
  assert.deepEqual(failed.text.tickCount, [18,18,18]);
  failed.restore();
});
