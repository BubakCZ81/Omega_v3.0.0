import assert from 'node:assert/strict';
import test from 'node:test';
import { convertPineScriptToV6 } from './pineVersionConverter.mjs';

test('upgrades a v5 script to the v6 directive and namespaces built-ins', () => {
  const result = convertPineScriptToV6([
    '//@version=5',
    'study("EMA", overlay = true)',
    'len = input(20, "Length")',
    'plot(ema(close, len))',
  ].join('\n'));
  assert.equal(result.version, 5);
  assert.equal(result.changes, 1);
  assert.match(result.source, /\/\/@version=6/);
  assert.match(result.source, /indicator\("EMA", overlay = true\)/);
  assert.match(result.source, /ta\.ema\(close, len\)/);
  assert.doesNotMatch(result.source, /\/\/@version=5/);
});

test('legacy input types become input.* constructors', () => {
  const result = convertPineScriptToV6([
    '//@version=4',
    'study("Inputs")',
    'length = input(14, "Length", integer)',
    'enabled = input(true, "Enabled", bool)',
    'plot(close)',
  ].join('\n'));
  assert.match(result.source, /input\.int\(14, "Length"\)/);
  assert.match(result.source, /input\.bool\(true, "Enabled"\)/);
});

test('user-defined functions keep their own names', () => {
  const result = convertPineScriptToV6([
    '//@version=5',
    'indicator("Own functions")',
    'ema(source, length) =>',
    '    ta.sma(source, length)',
    'plot(ema(close, 20))',
  ].join('\n'));
  assert.match(result.source, /plot\(ema\(close, 20\)\)/);
  assert.doesNotMatch(result.source, /ta\.ema\(close/);
});

test('rejects unsupported sources with actionable errors', () => {
  assert.throws(() => convertPineScriptToV6(''), /editor is empty/);
  assert.throws(() => convertPineScriptToV6('indicator("No directive")\nplot(close)'), /version directive/);
  assert.throws(() => convertPineScriptToV6('//@version=5\n//@version=5\nindicator("Two")\nplot(close)'), /version directive/);
  assert.throws(() => convertPineScriptToV6('//@version=6\nindicator("Six")\nplot(close)'), /already uses Pine Script v6/);
  assert.throws(() => convertPineScriptToV6('//@version=2\nindicator("Old")\nplot(close)'), /not supported/);
  assert.throws(() => convertPineScriptToV6('//@version=5\nindicator("Iff")\nplot(iff(close > open, 1, 0))'), /iff\(\)/);
  assert.throws(() => convertPineScriptToV6('//@version=5\nplot(close)'), /no indicator\(\), strategy\(\), or library\(\)/);
});
