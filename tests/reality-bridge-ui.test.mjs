import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
const source = stripTypeScriptTypes(readFileSync(new URL('../lib/clipboard.ts', import.meta.url), 'utf8')).replace(/export /g, '');
function clipboard(native, legacy) {
  let removed = false, value;
  const area = { style: {}, setAttribute() {}, focus() {}, select() {}, remove() { removed = true; }, set value(text) { value = text; } };
  const context = vm.createContext({ navigator: { clipboard: native }, document: { activeElement: { focus() {} }, createElement: () => area, body: { appendChild() {} }, execCommand: () => legacy } });
  vm.runInContext(source, context);
  return { copy: context.copyTextToClipboard, removed: () => removed, value: () => value };
}
test('clipboard rejection falls back to a selected textarea', async () => {
  const app = clipboard({ writeText: async () => { throw new Error('denied'); } }, true);
  assert.equal(await app.copy('hello'), true);
  assert.equal(app.value(), 'hello');
  assert.equal(app.removed(), true);
});
test('unavailable clipboard and failed fallback return failure', async () => {
  assert.equal(await clipboard(undefined, false).copy('hello'), false);
});
test('successful native clipboard does not use the fallback', async () => {
  const app = clipboard({ writeText: async () => {} }, false);
  assert.equal(await app.copy('hello'), true);
  assert.equal(app.removed(), false);
});
