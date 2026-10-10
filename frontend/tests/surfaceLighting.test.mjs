import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/components/SeismicViewer3D/surfaceLighting.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {surfaceLightingVertexSource,applySurfaceLighting} = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
// Read the shader from the actual pinned renderer so a dependency upgrade
// cannot silently keep applying an obsolete shader patch.
const bundle = await readFile(new URL('../node_modules/plotly.js-dist-min/plotly.min.js', import.meta.url), 'utf8');
const lighting = bundle.indexOf('vec4 cameraCoordinate = view * vec4(position , 1.0);');
assert.ok(lighting > 0);
const vertex = bundle.slice(bundle.lastIndexOf('`', lighting) + 1, bundle.indexOf('`', lighting));

test('pinned mesh shader uses one lighting space and corrects mirrored-axis normals', () => {
  const fixed = surfaceLightingVertexSource(vertex);
  assert.ok(fixed.includes('cameraCoordinate = model * vec4(position, 1.0)'));
  assert.ok(fixed.includes('(model * vec4(lightPosition, 1.0)).xyz - cameraCoordinate.xyz'));
  assert.ok(fixed.includes('(model * vec4(eyePosition, 1.0)).xyz - cameraCoordinate.xyz'));
  assert.ok(fixed.includes('orientation * normalize((vec4(normal, 0.0) * inverseModel).xyz)'));
  assert.ok(fixed.includes('sign(dot(cross(model[0].xyz, model[1].xyz), model[2].xyz))'));
  // Shading must not move physical vertices or change the projection/UVs.
  assert.equal(fixed.slice(fixed.indexOf('vec4 project'), fixed.indexOf('//Lighting geometry')),
    vertex.slice(vertex.indexOf('vec4 project'), vertex.indexOf('//Lighting geometry')));
  assert.equal(fixed.slice(fixed.indexOf('  f_color')), vertex.slice(vertex.indexOf('  f_color')));
});

test('installs once, preserving GPU buffers, fragment shader and attribute locations', () => {
  const updates = [];
  const shader = {
    vertShader: 'vertex', fragShader: 'fragment',
    attributes: {position:{location:3},normal:{location:1}},
    types: {attributes:{position:'vec3',normal:'vec3'}},
    update(...args) {updates.push(args);},
  };
  const positions = {}, texture = {};
  const mesh = {triShader:shader,trianglePositions:positions,texture};
  const element = {_fullLayout:{scene:{_scene:{
    traces:{h:{mesh},slice:{surface:{}}},
    glplot:{gl:{getShaderSource: id => id === 'vertex' ? vertex : 'fragment source'}},
  }}}};
  applySurfaceLighting(element);
  applySurfaceLighting(element);
  assert.equal(updates.length, 1);
  assert.equal(updates[0][1], 'fragment source');
  assert.equal(updates[0][2], undefined);
  assert.deepEqual(updates[0][3], [
    {name:'position',type:'vec3',location:3}, {name:'normal',type:'vec3',location:1},
  ]);
  assert.equal(mesh.trianglePositions, positions);
  assert.equal(mesh.texture, texture);
});

test('rejects an incompatible shader and tolerates a scene without mesh actors', () => {
  assert.throws(() => surfaceLightingVertexSource('other renderer'), /Unsupported Plotly/);
  assert.doesNotThrow(() => applySurfaceLighting({}));
  assert.doesNotThrow(() => applySurfaceLighting({_fullLayout:{scene:{_scene:{glplot:{},traces:{}}}}}));
});
