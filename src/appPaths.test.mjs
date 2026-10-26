import assert from 'node:assert/strict';
import test from 'node:test';
import { appAssetUrl } from './appPaths.ts';

test('appAssetUrl resolves paths against the document base URI', () => {
  const previous = globalThis.document;
  globalThis.document = { baseURI: 'file:///C:/omega/dist/index.html' };
  try {
    assert.equal(appAssetUrl('indicators/catalog.json'), 'file:///C:/omega/dist/indicators/catalog.json');
    assert.equal(appAssetUrl('/indicators/catalog.json'), 'file:///C:/omega/dist/indicators/catalog.json');
    assert.equal(appAssetUrl('///assets/logo.png'), 'file:///C:/omega/dist/assets/logo.png');
  } finally {
    globalThis.document = previous;
  }
});
