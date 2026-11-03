import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64');
const react = moduleURL(`
  export const useRef = value => ({ current: value });
  export const useEffect = effect => { globalThis.modalFocusCleanup = effect(); };
`);
const source = (await readFile(new URL('../src/hooks/useModalFocus.ts', import.meta.url), 'utf8'))
  .replace('"react"', JSON.stringify(react));
const { useModalFocus } = await import(moduleURL(source));

function withDialog(run, canClose = true) {
  const originalDocument = globalThis.document, originalNow = Date.now;
  const listeners = new Map();
  let now = 1000, closes = 0;
  const opener = { isConnected: true, focus() { document.activeElement = this; } };
  const control = { tabIndex: 0, getClientRects: () => [1], focus() { document.activeElement = this; } };
  const dialog = { querySelectorAll: () => [control], getClientRects: () => [1], contains: el => el === control };
  let modals = [dialog];
  globalThis.document = {
    activeElement: opener, querySelectorAll: () => modals,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: type => listeners.delete(type),
  };
  Date.now = () => now;
  const fire = (type, props = {}) => {
    const event = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
    listeners.get(type)?.(event);
    return event;
  };
  try {
    useModalFocus({ current: dialog }, true, () => closes++, canClose);
    run({ fire, advance: ms => { now += ms; }, closes: () => closes,
      cover: () => { modals = [dialog, { getClientRects: () => [1] }]; } });
    globalThis.modalFocusCleanup();
    assert.equal(listeners.size, 0);
    assert.equal(document.activeElement, opener);
  } finally {
    Date.now = originalNow;
    globalThis.document = originalDocument;
    delete globalThis.modalFocusCleanup;
  }
}

test('IME cancellation and held Escape cannot dismiss a modal', () => withDialog(({ fire, advance, closes }) => {
  fire('keydown', { isComposing: true });
  fire('keydown', { keyCode: 229 });
  fire('keydown', { repeat: true });
  fire('compositionstart');
  fire('keydown');
  fire('compositionend');
  fire('keydown');
  advance(499);
  fire('keydown');
  assert.equal(closes(), 0);
  advance(1);
  assert.equal(fire('keydown').defaultPrevented, true);
  assert.equal(closes(), 1);
}));

test('busy dialogs and dialogs below another modal cannot close on Escape', () => {
  withDialog(({ fire, closes }) => { fire('keydown'); assert.equal(closes(), 0); }, false);
  withDialog(({ fire, closes, cover }) => {
    fire('keydown', { defaultPrevented: true });
    cover();
    fire('keydown');
    assert.equal(closes(), 0);
  });
});
