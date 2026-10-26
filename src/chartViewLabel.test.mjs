import assert from 'node:assert/strict';
import test from 'node:test';
import { chartStyleCode, chartStyleName, chartViewLabel, formatTimeframeLabel } from './chartViewLabel.ts';

test('timeframe labels use compact minute/hour/day notation', () => {
  assert.equal(formatTimeframeLabel('1'), '1m');
  assert.equal(formatTimeframeLabel('5'), '5m');
  assert.equal(formatTimeframeLabel('60'), '1h');
  assert.equal(formatTimeframeLabel('240'), '4h');
  assert.equal(formatTimeframeLabel('D'), '1D');
  assert.equal(formatTimeframeLabel('W'), '1W');
  assert.equal(formatTimeframeLabel('T100'), '100T');
});

test('the chart view shows the style next to the period', () => {
  assert.equal(chartViewLabel('candles', '1'), '1m');
  assert.equal(chartViewLabel('heikinashi', '1'), 'Heikin 1m');
  assert.equal(chartViewLabel('heikinashi', '60'), 'Heikin 1h');
  assert.equal(chartViewLabel('renko', '60', 5), 'Renko 5 pips');
  assert.equal(chartViewLabel('range', '60', 10), 'Range 10 pips');
  assert.equal(chartViewLabel('line', '15'), 'Line · 15m');
});

test('statusline codes stay short and readable', () => {
  assert.equal(chartStyleCode('candles', '5'), '5m');
  assert.equal(chartStyleCode('candles', '60'), '1h');
  assert.equal(chartStyleCode('heikinashi', '5'), 'Hm5');
  assert.equal(chartStyleCode('heikinashi', '60'), 'Hm1h');
  assert.equal(chartStyleCode('heikinashi', 'D'), 'Hm1D');
  assert.equal(chartStyleCode('renko', '60', 50), 'Re50');
  assert.equal(chartStyleCode('range', '60', 200), 'Ra200');
  assert.equal(chartStyleCode('line', '15'), 'Li15');
  assert.equal(chartStyleCode('candles', 'T100'), '100T');
});

test('style names describe the active chart type', () => {
  assert.equal(chartStyleName('candles'), 'Candles');
  assert.equal(chartStyleName('heikinashi'), 'Heikin Ashi');
  assert.equal(chartStyleName('renko'), 'Renko');
  assert.equal(chartStyleName('range'), 'Range');
});
