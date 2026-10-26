const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { isTrustedAppDocument } = require('./trusted-pages.cjs');

const distDirectory = path.resolve('C:/Program Files/Omega/resources/app/dist');
const options = { devServerUrl: 'http://127.0.0.1:5173', distDirectory };

function fileUrl(name) {
  return pathToFileURL(path.join(distDirectory, name)).href;
}

test('packaged application documents are trusted', () => {
  for (const name of ['index.html', 'pine-editor.html', 'visual-backtest.html']) {
    assert.equal(isTrustedAppDocument(fileUrl(name), options), true, name);
  }
  assert.equal(isTrustedAppDocument(`${fileUrl('pine-editor.html')}?window=pine-editor`, options), true);
});

test('other files and directories are rejected', () => {
  assert.equal(isTrustedAppDocument(fileUrl('other.html'), options), false);
  assert.equal(isTrustedAppDocument('file:///C:/Windows/System32/index.html', options), false);
  assert.equal(isTrustedAppDocument(fileUrl('../index.html'), options), false);
  assert.equal(isTrustedAppDocument('file:///C:/Program Files/Omega/resources/app/dist/', options), false);
  assert.equal(isTrustedAppDocument('not a url', options), false);
  assert.equal(isTrustedAppDocument('', options), false);
});

test('the Vite dev server documents are trusted', () => {
  assert.equal(isTrustedAppDocument('http://127.0.0.1:5173/', options), true);
  assert.equal(isTrustedAppDocument('http://127.0.0.1:5173/pine-editor.html', options), true);
  // The dev server origin must match exactly; another loopback host name is a
  // different origin and is rejected.
  assert.equal(isTrustedAppDocument('http://localhost:5173/visual-backtest.html?x=1', options), false);
  assert.equal(isTrustedAppDocument('http://127.0.0.1:5173/src/main.ts', options), false);
  assert.equal(isTrustedAppDocument('http://127.0.0.1:9999/index.html', options), false);
});

test('non-loopback and non-http URLs are rejected', () => {
  assert.equal(isTrustedAppDocument('https://example.com/index.html', options), false);
  assert.equal(isTrustedAppDocument('http://192.168.1.10:5173/index.html', options), false);
  assert.equal(isTrustedAppDocument('data:text/html,<html></html>', options), false);
  assert.equal(isTrustedAppDocument('javascript:alert(1)', options), false);
  assert.equal(isTrustedAppDocument('file:///C:/dist/index.html', { distDirectory: '' }), false);
});
