import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePineStaticSource } from './pineStaticValidator.ts';

test('valid Pine v6 source has no static diagnostics', () => {
  const source = [
    '//@version=6',
    'indicator("Valid example", overlay=true)',
    'plot(ta.sma(close, 14))',
  ].join('\n');

  assert.deepEqual(validatePineStaticSource(source), []);
});

test('Pine v6 validation reports function signature errors at the source location', () => {
  const source = [
    '//@version=6',
    'indicator("Broken example", overlay=true)',
    'plot(ta.sma(close))',
  ].join('\n');

  assert.deepEqual(validatePineStaticSource(source), [{
    message: "Missing required parameter(s) for 'ta.sma': length",
    line: 3,
    column: 6,
    length: 6,
    severity: 'error',
    source: 'Pine Script v6 Validator (unofficial)',
  }]);
});

test('Pine v6 validation flags unknown methods but accepts documented methods', () => {
  const unknownSource = [
    '//@version=6',
    'indicator("Unknown method", overlay=true)',
    'plot(ta.smaaa(close, 14))',
  ].join('\n');
  const validSource = [
    '//@version=6',
    'indicator("Known method", overlay=true)',
    'plot(ta.sma(close, 14))',
  ].join('\n');

  const diagnostics = validatePineStaticSource(unknownSource);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].line, 3);
  assert.equal(diagnostics[0].column, 9);
  assert.match(diagnostics[0].message, /Undefined function 'ta\.smaaa'/);
  assert.equal(diagnostics[0].severity, 'error');
  assert.deepEqual(validatePineStaticSource(validSource), []);
});

test('v5 source is not judged by the Pine v6-only validator', () => {
  const diagnostics = validatePineStaticSource('//@version=5\nindicator("Legacy", overlay=true)');

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, 'info');
  assert.match(diagnostics[0].message, /Pine v5 checks were skipped/);
});

test('empty source does not produce a version diagnostic', () => {
  assert.deepEqual(validatePineStaticSource(' \n\t'), []);
});
