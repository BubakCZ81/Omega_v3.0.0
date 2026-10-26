import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTimeframe, timeframeInputState } from './timeframeSelection.ts';

test('parses minute, hour, day, and week timeframe aliases', () => {
  assert.deepEqual(timeframeInputState('15'), { value: 15, unit: 'minutes' });
  assert.deepEqual(timeframeInputState('120'), { value: 2, unit: 'hours' });
  assert.deepEqual(timeframeInputState('D1'), { value: 1, unit: 'days' });
  assert.deepEqual(timeframeInputState('W'), { value: 7, unit: 'days' });
});

test('parses bounded tick timeframes and rejects invalid values', () => {
  assert.deepEqual(timeframeInputState('T250'), { value: 250, unit: 'ticks' });
  assert.equal(timeframeInputState('T0'), null);
  assert.equal(timeframeInputState('T10001'), null);
  assert.equal(timeframeInputState('0'), null);
  assert.equal(timeframeInputState('2W'), null);
});

test('retries timeframe application once when the chart does not retain it', async () => {
  const calls = [];
  const chart = {
    market: { timeframe: '60' },
    async setMarket(market) {
      calls.push(market.timeframe);
      this.market.timeframe = calls.length === 1 ? '60' : market.timeframe;
    },
  };

  assert.equal(await applyTimeframe(chart, '15'), '15');
  assert.deepEqual(calls, ['15', '15']);
});

test('returns the chart timeframe after retry when it still differs', async () => {
  let calls = 0;
  const chart = {
    market: { timeframe: '60' },
    async setMarket() {
      calls += 1;
      this.market.timeframe = '5';
    },
  };

  assert.equal(await applyTimeframe(chart, '15'), '5');
  assert.equal(calls, 2);
});

test('propagates chart errors rather than reporting a successful timeframe change', async () => {
  const chart = {
    market: { timeframe: '60' },
    async setMarket() {
      throw new Error('chart unavailable');
    },
  };

  await assert.rejects(applyTimeframe(chart, '15'), /chart unavailable/);
});
