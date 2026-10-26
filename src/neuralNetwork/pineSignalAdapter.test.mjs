import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNeuralTrainingSamples, validateNeuralSignalSource } from './pineSignalAdapter.ts';

test('requires explicit directional signal and feature plots', () => {
  assert.equal(validateNeuralSignalSource('plot(long, "NN_LONG_SIGNAL")').ok, false);
  const result = validateNeuralSignalSource(`plot(long, "NN_LONG_SIGNAL")\nplot(short, "NN_SHORT_SIGNAL")\nplot(close, "NN_FEATURE_CLOSE")\nplot(atr, "NN_FEATURE_ATR")`);
  assert.equal(result.ok, true);
  assert.deepEqual(result.featureKeys, ['NN_FEATURE_CLOSE', 'NN_FEATURE_ATR']);
});

test('labels only settled directional signals as trade or skip', () => {
  const point = value => ({ time: 0, value });
  const samples = buildNeuralTrainingSamples({
    NN_LONG_SIGNAL: [point(1), point(0), point(0)],
    NN_SHORT_SIGNAL: [point(0), point(0), point(1)],
    NN_FEATURE_CLOSE: [point(10), point(12), point(11)],
    NN_FEATURE_ATR: [point(2), point(2), point(2)],
  }, ['NN_FEATURE_ATR'], 1);
  assert.deepEqual(samples, [{ features: [2], label: 1 }]);
});
