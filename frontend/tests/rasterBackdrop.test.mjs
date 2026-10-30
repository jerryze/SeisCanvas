import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/components/rasterBackdrop.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { syncRasterBackdrop, installRasterBackdrop } = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

// Small SVG fixture: no drawing or Plotly mocks are needed to verify the exact
// existing bitmap bounds, DOM stacking, event ownership and lifetime behavior.
class Element {
  constructor(tag, document) {
    this.tag = tag; this.ownerDocument = document; this.attributes = new Map(); this.children = []; this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, next) {
    child.remove();
    const index = next === null ? this.children.length : this.children.indexOf(next);
    assert.ok(index >= 0);
    this.children.splice(index, 0, child); child.parentNode = this; return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null; }
  matches(part) { return part.startsWith('.') ? (this.getAttribute('class') ?? '').split(' ').includes(part.slice(1)) : this.tag === part; }
  querySelectorAll(selector) {
    const parts = selector.split(' '), all = [];
    const visit = node => { for (const child of node.children) { all.push(child); visit(child); } };
    visit(this);
    return all.filter(element => {
      let index = parts.length - 1, current = element;
      if (!current.matches(parts[index--])) return false;
      while (index >= 0) {
        current = current.parentNode;
        while (current && !current.matches(parts[index])) current = current.parentNode;
        if (!current) return false;
        index--;
      }
      return true;
    });
  }
}

function fixture() {
  const document = { createElementNS(namespace, name) { assert.equal(namespace, 'http://www.w3.org/2000/svg'); return new Element(name, document); } };
  const node = (name, attributes = {}) => {
    const element = new Element(name, document);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  };
  const el = node('div'), svg = el.appendChild(node('svg'));
  const heatmaps = svg.appendChild(node('g', { class: 'heatmaplayer' }));
  const group = heatmaps.appendChild(node('g', { class: 'hm' }));
  const image = group.appendChild(node('image', { x: -200.5, y: -100.25, width: 800, height: 500,
    'xlink:href': 'data:image/png;base64,original-with-transparent-null-cells' }));
  const navigation = svg.appendChild(node('g', { class: 'imagelayer' })).appendChild(node('image', { x: -5000, width: 10000 }));
  const foreign = group.appendChild(node('rect', { 'data-existing': 'true' }));
  const listeners = new Map();
  el.on = (event, handler) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
  };
  el.removeListener = (event, handler) => listeners.get(event)?.delete(handler);
  el.emit = event => { for (const callback of [...(listeners.get(event) ?? [])]) callback(); };
  el._fullLayout = { plot_bgcolor: '#fff' };
  const owned = () => el.querySelectorAll('rect').filter(rect => rect.getAttribute('data-seiscanvas-raster-backdrop') === 'true');
  return { el, node, heatmaps, group, image, navigation, foreign, listeners, owned };
}

test('actual bitmap bounds mask transparent nulls without extending across the larger cached data extent', () => {
  const h = fixture(), original = [...h.image.attributes];
  syncRasterBackdrop(h.el);
  const [rect] = h.owned();
  assert.equal(h.owned().length, 1);
  for (const attribute of ['x', 'y', 'width', 'height']) assert.equal(rect.getAttribute(attribute), h.image.getAttribute(attribute));
  assert.equal(rect.getAttribute('fill'), '#fff');
  assert.equal(rect.getAttribute('fill-opacity'), '1');
  assert.equal(rect.getAttribute('pointer-events'), 'none');
  assert.equal(rect.getAttribute('aria-hidden'), 'true');
  assert.equal(rect.nextSibling, h.image, 'opaque background is immediately underneath the transparent bitmap');
  assert.deepEqual([...h.image.attributes], original, 'amplitudes, PNG, interpolation and original attributes are untouched');
  assert.equal(h.navigation.parentNode.children.length, 1, 'navigation images receive no masking backdrop');
  installRasterBackdrop(h.el)();
});

test('afterplot synchronizes replacement/cropped images and removes stale masks when Plotly discards an image', () => {
  const h = fixture(), cleanup = installRasterBackdrop(h.el);
  const original = h.owned()[0];
  h.image.setAttribute('x', -50.25); h.image.setAttribute('width', 250);
  h.el._fullLayout.plot_bgcolor = '#243647';
  h.el.emit('plotly_afterplot');
  assert.equal(h.owned()[0], original);
  assert.equal(original.getAttribute('x'), '-50.25');
  assert.equal(original.getAttribute('width'), '250');
  assert.equal(original.getAttribute('fill'), '#243647');
  h.image.remove(); h.el.emit('plotly_afterplot');
  assert.equal(h.owned().length, 0, 'a removed fine bitmap cannot keep hiding the full overview');
  assert.equal(original.parentNode, null);
  const replacement = h.group.appendChild(h.node('image', { x: 10, y: 20, width: 30, height: 40 }));
  h.el.emit('plotly_afterplot');
  assert.equal(h.owned()[0].nextSibling, replacement);
  h.group.remove(); h.el.emit('plotly_afterplot');
  assert.equal(h.owned().length, 0);
  cleanup();
});

test('native pan transforms the bitmap and its mask together without relayout calls or image changes', () => {
  const h = fixture(), cleanup = installRasterBackdrop(h.el);
  const rect = h.owned()[0];
  h.group.setAttribute('transform', 'translate(-300, 25) scale(2, .5)');
  assert.equal(rect.parentNode, h.image.parentNode);
  assert.equal(rect.parentNode.getAttribute('transform'), 'translate(-300, 25) scale(2, .5)');
  assert.equal(rect.getAttribute('transform'), null);
  h.image.setAttribute('transform', 'translate(2, 3)');
  h.image.setAttribute('clip-path', 'url(#fine)');
  h.el.emit('plotly_afterplot');
  assert.equal(rect.getAttribute('transform'), 'translate(2, 3)');
  assert.equal(rect.getAttribute('clip-path'), 'url(#fine)');
  h.image.removeAttribute('transform'); h.image.removeAttribute('clip-path'); h.el.emit('plotly_afterplot');
  assert.equal(rect.getAttribute('transform'), null);
  assert.equal(rect.getAttribute('clip-path'), null);
  cleanup();
});

test('installation/cleanup are idempotent and preserve every unrelated SVG node and listener', () => {
  const h = fixture();
  let afterplots = 0, relayouts = 0;
  const other = () => afterplots++;
  h.el.on('plotly_afterplot', other); h.el.on('plotly_relayout', () => relayouts++);
  const cleanup = installRasterBackdrop(h.el);
  assert.equal(installRasterBackdrop(h.el), cleanup);
  assert.equal(h.listeners.get('plotly_afterplot').size, 2);
  assert.equal(h.owned().length, 1);
  h.el.emit('plotly_afterplot');
  assert.equal(afterplots, 1, 'sync never emits another afterplot or requests a Plotly redraw');
  assert.equal(relayouts, 0);
  cleanup(); cleanup();
  assert.equal(h.owned().length, 0);
  assert.equal(h.listeners.get('plotly_afterplot').size, 1);
  assert.equal(h.foreign.parentNode, h.group);
  assert.equal(h.image.parentNode, h.group);
  assert.equal(h.navigation.parentNode.children.length, 1);
  h.el.emit('plotly_afterplot'); h.el.emit('plotly_relayout');
  assert.equal(afterplots, 2); assert.equal(relayouts, 1);
  const nextCleanup = installRasterBackdrop(h.el);
  assert.notEqual(nextCleanup, cleanup);
  assert.equal(h.owned().length, 1);
  cleanup(); assert.equal(h.owned().length, 1, 'an old cleanup cannot remove a newer installation');
  nextCleanup();
});

test('all valid fine images get their own backdrop; invalid or zero-size images leave no opaque region', () => {
  const h = fixture(), second = h.heatmaps.appendChild(h.node('g', { class: 'hm' }));
  const image = second.appendChild(h.node('image', { width: 100, height: 50 }));
  const cleanup = installRasterBackdrop(h.el);
  assert.equal(h.owned().length, 2);
  const rect = h.owned().find(rect => rect.nextSibling === image);
  assert.equal(rect.getAttribute('x'), '0'); assert.equal(rect.getAttribute('y'), '0');
  image.setAttribute('width', 0); h.el.emit('plotly_afterplot');
  assert.equal(h.owned().length, 1);
  image.setAttribute('width', 100); image.setAttribute('y', 'NaN'); h.el.emit('plotly_afterplot');
  assert.equal(h.owned().length, 1);
  cleanup();
});
