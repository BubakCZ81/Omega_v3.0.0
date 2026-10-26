import assert from 'node:assert/strict';
import test from 'node:test';
import { patchVelaDismissal, velaManualDismissalPlugin } from './velaDismissalPatch.mjs';

test('non-chunk assets are left untouched', () => {
  assert.equal(patchVelaDismissal('index.js', 'closeOnInteractOutside: opts.closeOnInteractOutside ?? true,'), null);
  assert.equal(patchVelaDismissal('chunk-a.js', 'const unrelated = 1;'), null);
});

test('the drawer default keeps dialogs open on outside interaction', () => {
  const source = 'const opts = { closeOnInteractOutside: opts.closeOnInteractOutside ?? true, };';
  const patched = patchVelaDismissal('chunk-abc123.js', source);
  assert.equal(patched, 'const opts = { closeOnInteractOutside: opts.closeOnInteractOutside ?? false, };');
  // The upstream source is never mutated in place.
  assert.match(source, /\?\? true/);
});

test('unexpected occurrence counts are reported instead of silently patched', () => {
  assert.throws(
    () => patchVelaDismissal('chunk-abc123.js', 'closeOnInteractOutside: true,'),
    /expected 4 occurrence\(s\) of dialog outside-dismissal policy, found 1/,
  );
  assert.throws(
    () => patchVelaDismissal('chunk-abc123.js', 'closeOnInteractOutside: opts.closeOnInteractOutside ?? true,\ncloseOnInteractOutside: opts.closeOnInteractOutside ?? true,'),
    /expected 1 occurrence\(s\) of default drawer outside-dismissal policy, found 2/,
  );
});

test('the vite plugin only transforms @luxalgo/vela dist chunks', () => {
  const plugin = velaManualDismissalPlugin();
  assert.equal(plugin.name, 'vela-manual-dismissal');
  assert.equal(plugin.enforce, 'pre');

  assert.equal(plugin.transform('closeOnInteractOutside: true,', '/app/src/main.ts'), null);
  assert.equal(plugin.transform('closeOnInteractOutside: true,', 'C:\\app\\node_modules\\other\\dist\\chunk-x.js'), null);

  const patched = plugin.transform(
    'closeOnInteractOutside: opts.closeOnInteractOutside ?? true,',
    'C:\\app\\node_modules\\@luxalgo\\vela\\dist\\chunk-abc123.js',
  );
  assert.match(patched.code, /\?\? false/);
  assert.equal(patched.map, null);
});
