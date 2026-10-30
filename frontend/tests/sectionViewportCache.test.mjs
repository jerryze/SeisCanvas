import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64');
const raster = moduleURL(await readFile(new URL('../src/components/loadedRaster.ts', import.meta.url), 'utf8'));
const source = (await readFile(new URL('../src/hooks/sectionViewportCache.ts', import.meta.url), 'utf8'))
  .replace('"../components/loadedRaster"', JSON.stringify(raster));
const { SectionViewportCache, sectionWindowBytes, sectionWindowIsFinal } = await import(moduleURL(source));
const section = (extent = [0, 10, 0, 10]) => ({
  z: [[1, 2], [3, 4]], x: [0, 10], time: [0, 10], raster_extent: extent, preview_shape: [100, 100],
  horizons: {}, vmin: -10, vmax: 10,
});
const request = (key, patch = {}) => ({
  key, x: [0, 10], time: [0, 10], width: 100, height: 100, interpolate: true, overlays: true, ...patch,
});

test('recent windows evict the least recently used entry after three, and exact geometry wins', () => {
  const cache = new SectionViewportCache();
  const frames = ['a', 'b', 'c', 'd'].map(() => section());
  for (let i = 0; i < 3; i++) cache.remember('abc'[i], frames[i]);
  assert.equal(cache.find(request('a')).data, frames[0]);
  cache.remember('d', frames[3]);
  assert.equal(cache.find(request('b')), null);
  assert.equal(cache.find(request('a', { overlays: false })).data, frames[0]);
  assert.equal(cache.find(request('c')).data, frames[2]);
  assert.equal(cache.find(request('d')).data, frames[3]);
});

test('the byte budget includes geometry, excludes shared overview and rejects oversized entries', () => {
  const data = section(), cost = sectionWindowBytes(data);
  const overview = { z: Array.from({ length: 50 }, () => Array(100).fill(1)) };
  assert.equal(sectionWindowBytes({ ...data, overview }), cost);
  assert.ok(sectionWindowBytes({ ...data, trace_overlay: { wiggle: { x: Array(100).fill(1), time: [] } } }) > cost);
  const cache = new SectionViewportCache(cost * 2, 3);
  cache.remember('a', data); cache.remember('b', { ...section(), overview });
  cache.remember('c', section());
  assert.equal(cache.find(request('a')), null);
  assert.ok(cache.find(request('b')));
  assert.ok(cache.find(request('c')));
  const huge = { ...section(), z: [Array(cost).fill(0)] };
  cache.remember('large', huge);
  assert.equal(cache.find(request('large')), null);
  assert.ok(cache.find(request('b')), 'oversized active data do not become another historical allocation');
});

test('coverage requires fine detail density and never promotes overview coverage to final data', () => {
  const cache = new SectionViewportCache();
  const detail = { ...section([0, 1, 0, 1]), overview: section([0, 10, 0, 10]) };
  cache.remember('fine', detail);
  assert.equal(cache.find(request('outside', { overlays: false })), null);
  assert.equal(cache.find(request('deep', { x: [.4, .6], time: [.4, .6], overlays: false })), null);
  assert.equal(cache.find(request('covered', { x: [0, .99], time: [0, .99], overlays: false })).data, detail);
  assert.equal(sectionWindowIsFinal(cache.find(request('covered', { x: [0, .99], time: [0, .99], overlays: false })),
    request('covered', { x: [0, .99], time: [0, .99], overlays: false })), false,
    'coverage and sufficient density do not make different interpolation centres equivalent');
  assert.equal(cache.find(request('overlay', { x: [0, 1], time: [0, 1] })), null);
  assert.equal(cache.find(request('native', { x: [.4, .6], time: [.4, .6], interpolate: false, overlays: false })).data, detail);
  assert.equal(sectionWindowIsFinal(cache.find(request('native', { x: [.4, .6], time: [.4, .6], interpolate: false, overlays: false })),
    request('native', { x: [.4, .6], time: [.4, .6], interpolate: false, overlays: false })), true);
  cache.clear();
  assert.equal(cache.find(request('fine')), null);
});

test('subpixel shifts remain temporary previews while exact geometry is final', () => {
  const cache = new SectionViewportCache();
  const detail = { ...section([0, 1, 0, 1]), z: [[123.456789, null], [-8, 0]] };
  const entry = cache.remember('original', detail);
  const shifted = request('shifted', { x: [.001, .991], time: [.002, .992], width: 99, height: 99, overlays: false });
  assert.equal(cache.find(shifted), entry);
  assert.equal(sectionWindowIsFinal(entry, shifted), false);
  assert.equal(sectionWindowIsFinal(entry, request('original')), true);
  assert.equal(entry.data.z, detail.z, 'preview selection never modifies precise values or missing cells');
});
