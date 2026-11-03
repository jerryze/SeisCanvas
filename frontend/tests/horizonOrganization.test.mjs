import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const code = ts.transpileModule(await readFile(new URL('../src/horizonOrganization.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { modelGroups, layerFromName, suggestModel, referenceMapping, referencePreview, patchHorizon, organizeHorizons, inheritLayerColors, mappingRows } =
  await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const row = (id, model_group = '', horizon_key = '', color = '#112233') => ({ id, name: id, model_group, horizon_key, color, visible: true, line: { style: 'solid', width: 1.5 } });

test('mapping search and missing filter preserve original row indices when editing a batch', () => {
  const names = ['Base_1', 'Base_2', 'Base_3', 'Base_10'];
  const keys = ['T24', '', 'T30', ' '];
  assert.deepEqual(mappingRows(names, keys, ' base_ ', true), [{name:'Base_2', index:1}, {name:'Base_10', index:3}]);
  assert.deepEqual(mappingRows(names, keys, 't30', false), [{name:'Base_3', index:2}]);
  assert.deepEqual(mappingRows(names, keys, 't30', true), []);
  const visible = mappingRows(names, keys, '10', true);
  const next = keys.map((key, index) => index === visible[0].index ? 'T33' : key);
  assert.deepEqual(next, ['T24', '', 'T30', 'T33']);
  assert.deepEqual(keys, ['T24', '', 'T30', ' ']);
});

test('existing files remain ungrouped; same-named models collect nonadjacent members without changing source IDs', () => {
  const hs = [row('old'), row('Base_1', 'Base'), row('Ours_1', 'Ours'), row('Base_2', 'Base')];
  assert.deepEqual(modelGroups(hs).map(g => [g.name, g.members.map(h => h.id)]), [['', ['old']], ['Base', ['Base_1', 'Base_2']], ['Ours', ['Ours_1']]]);
});
test('file names suggest only common affixes; explicit model removal preserves true layer names', () => {
  assert.equal(suggestModel(['T24_DTW.txt', 'T25_DTW.dat']), 'DTW');
  assert.equal(suggestModel(['Base_1.txt', 'Base_2.txt']), 'Base');
  assert.equal(suggestModel(['T24_A.txt', 'T25_B.txt']), '');
  assert.equal(layerFromName('T24_DTW.txt', 'DTW'), 'T24');
  assert.equal(layerFromName('Base_10.txt', 'Base'), '10');
  assert.equal(layerFromName('T24_M[1].txt', 'M[1]'), 'T24');
  assert.equal(layerFromName('Base_1.txt', 'Ours'), 'Base_1');
});
test('reference correspondence uses natural file order, returns picker order and refuses missing/ambiguous rows', () => {
  const ref = [row('T30_DTW', 'DTW', 'T30'), row('T24_DTW', 'DTW', 'T24'), row('T25_DTW', 'DTW', 'T25')];
  assert.deepEqual(referenceMapping(['Base_10.txt', 'Base_2.txt', 'Base_1.txt'], ref), ['T30', 'T25', 'T24']);
  assert.throws(() => referenceMapping(['Base_1'], ref), /数量不同/);
  assert.throws(() => referenceMapping(['1', '2'], [row('a', 'R', 'T24'), row('b', 'R', 'T24')]), /不重复/);
  assert.throws(() => referenceMapping(['1'], [row('a', 'R')]), /完整/);
});
test('colour changes propagate across models only to the corresponding layer, other styles remain local', () => {
  const hs = [row('a', 'DTW', 'T24'), row('b', 'Base', 'T24'), row('c', 'Ours', 'T25'), row('d')];
  const before = structuredClone(hs);
  const next = patchHorizon(hs, 'b', { color: '#aabbcc', line: { style: 'dashed', width: 2 } });
  assert.deepEqual(next.map(h => h.color), ['#aabbcc', '#aabbcc', '#112233', '#112233']);
  assert.equal(next[0].line.style, 'solid');
  assert.equal(next[1].line.style, 'dashed');
  assert.deepEqual(hs, before);
  assert.deepEqual(patchHorizon(hs, 'd', { color: '#abcdef' }).map(h => h.color), ['#112233', '#112233', '#112233', '#abcdef']);
});
test('batch grouping and reassignment inherit established colours without renaming or modifying file data', () => {
  const hs = [row('Base_1', '', '', '#ff0000'), row('T24_DTW', 'DTW', 'T24', '#ffaa00'), row('Ours_1', '', '', '#0000ff')];
  const next = organizeHorizons(hs, new Map([['Base_1', { model_group: ' Base ', horizon_key: ' T24 ' }], ['Ours_1', { model_group: 'Ours', horizon_key: 'T24' }]]));
  assert.deepEqual(next.map(h => h.color), ['#ffaa00', '#ffaa00', '#ffaa00']);
  assert.deepEqual(next.map(h => h.name), hs.map(h => h.name));
  assert.equal(next[0].model_group, 'Base');
  const detached = organizeHorizons(next, new Map([['Base_1', { model_group: '', horizon_key: '' }]]));
  assert.equal(detached[0].color, '#ffaa00');
  assert.equal(detached[0].horizon_key, '');
});
test('import inherits the current palette even if autosave has not sent the newest colour yet', () => {
  const existing = [row('DTW_1', 'DTW', 'T24', '#123456')];
  const added = [row('Base_1', 'Base', 'T24', '#ffffff'), row('Base_2', 'Base', 'T25', '#abcdef')];
  assert.deepEqual(inheritLayerColors(existing, added).map(h => h.color), ['#123456', '#abcdef']);
  assert.equal(added[0].color, '#ffffff');
});


test('reference preview exposes source filenames without applying any mappings', () => {
  const reference = [row('T25_DTW', 'DTW', 'T25'), row('T24_DTW', 'DTW', 'T24')];
  const before = structuredClone(reference);
  assert.deepEqual(referencePreview(['Base_2.txt', 'Base_1.txt'], reference), [
    { name: 'Base_2.txt', key: 'T25', reference: 'T25_DTW' },
    { name: 'Base_1.txt', key: 'T24', reference: 'T24_DTW' },
  ]);
  assert.deepEqual(reference, before);
  assert.throws(() => referencePreview(['only-one'], reference), /数量不同/);
});
