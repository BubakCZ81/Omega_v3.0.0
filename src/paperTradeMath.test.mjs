import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculatePaperTradePnl,
  createConfiguredProtectionLevels,
  formatPaperTradePnl,
  moveProtectionLevel,
  shouldTriggerPendingPaperOrder,
} from './paperTradeMath.ts';

test('pending limit orders trigger on the correct side of price', () => {
  const bar = { high: 105, low: 95 };
  assert.equal(shouldTriggerPendingPaperOrder('buy', 'limit', 100, bar), true);
  assert.equal(shouldTriggerPendingPaperOrder('buy', 'limit', 90, bar), false);
  assert.equal(shouldTriggerPendingPaperOrder('sell', 'limit', 100, bar), true);
  assert.equal(shouldTriggerPendingPaperOrder('sell', 'limit', 110, bar), false);
  assert.equal(shouldTriggerPendingPaperOrder('buy', 'stop', 106, bar), false);
  assert.equal(shouldTriggerPendingPaperOrder('sell', 'stop', 94, bar), false);
  assert.equal(shouldTriggerPendingPaperOrder('buy', 'stop', 104, bar), true);
  assert.equal(shouldTriggerPendingPaperOrder('sell', 'stop', 96, bar), true);
});

test('pending orders reject malformed prices instead of throwing', () => {
  assert.equal(shouldTriggerPendingPaperOrder('buy', 'limit', Number.NaN, { high: 1, low: 0 }), false);
  assert.equal(shouldTriggerPendingPaperOrder('buy', 'limit', 0, { high: 1, low: 0 }), false);
  assert.equal(shouldTriggerPendingPaperOrder('buy', 'limit', 1, { high: 0, low: 1 }), false);
});

test('pip protection uses pip size, not the broker tick size', () => {
  // 5-digit FX: one pip = 0.0001 while the broker tick is 0.00001.
  const levels = createConfiguredProtectionLevels('buy', 1.1, 0.00001, { mode: 'pips', slValue: 20, tpValue: 40 }, null, 0.0001);
  assert.ok(Math.abs((1.1 - levels.stopLoss) - 0.002) < 1e-12, '20 pips must be 0.0020');
  assert.ok(Math.abs((levels.takeProfit - 1.1) - 0.004) < 1e-12, '40 pips must be 0.0040');

  // Without an explicit pip size the tick size is the fallback (previous behaviour).
  const tickBased = createConfiguredProtectionLevels('buy', 1.1, 0.00001, { mode: 'pips', slValue: 20, tpValue: 40 });
  assert.ok(Math.abs((1.1 - tickBased.stopLoss) - 0.0002) < 1e-12);
});

test('pip protection is clamped to at least one tick and mirrors for sells', () => {
  const sell = createConfiguredProtectionLevels('sell', 1.2, 0.00001, { mode: 'pips', slValue: 20, tpValue: 40 }, null, 0.0001);
  assert.ok(sell.stopLoss > 1.2);
  assert.ok(sell.takeProfit < 1.2);

  const tiny = createConfiguredProtectionLevels('buy', 100, 0.5, { mode: 'pips', slValue: 0.001, tpValue: 0.001 });
  assert.equal(100 - tiny.stopLoss, 0.5);
  assert.equal(tiny.takeProfit - 100, 0.5);
});

test('ATR protection multiplies the ATR and requires a valid sample', () => {
  const levels = createConfiguredProtectionLevels('buy', 100, 0.01, { mode: 'atr', slValue: 1.5, tpValue: 3 }, 2);
  assert.equal(levels.stopLoss, 97);
  assert.equal(levels.takeProfit, 106);
  assert.throws(
    () => createConfiguredProtectionLevels('buy', 100, 0.01, { mode: 'atr', slValue: 1.5, tpValue: 3 }, null),
    /ATR\(14\) is unavailable/,
  );
  assert.throws(
    () => createConfiguredProtectionLevels('buy', 0, 0.01, { mode: 'pips', slValue: 20, tpValue: 40 }),
    /positive finite/,
  );
});

test('dragged protection levels cannot cross the entry', () => {
  assert.equal(moveProtectionLevel('buy', 'stopLoss', 100, 105, 0.1), 99.9);
  assert.equal(moveProtectionLevel('buy', 'takeProfit', 100, 99, 0.1), 100.1);
  assert.equal(moveProtectionLevel('sell', 'stopLoss', 100, 99, 0.1), 100.1);
  assert.equal(moveProtectionLevel('sell', 'takeProfit', 100, 105, 0.1), 99.9);
  assert.equal(moveProtectionLevel('buy', 'stopLoss', 100, 98, 0.1), 98);
});

test('paper P&L respects side and contract size', () => {
  assert.equal(calculatePaperTradePnl('buy', 100, 101, 1, 1), 1);
  assert.equal(calculatePaperTradePnl('sell', 100, 101, 1, 1), -1);
  assert.ok(Math.abs(calculatePaperTradePnl('buy', 1.08, 1.0801, 0.1, 100_000) - 1) < 1e-9);
  assert.throws(() => calculatePaperTradePnl('buy', 0, 1, 1, 1), /positive finite/);
});

test('P&L formatting keeps signs and currency codes', () => {
  assert.match(formatPaperTradePnl(12.5, 'USD'), /^\+.*12\.50/);
  assert.match(formatPaperTradePnl(-3, 'USD'), /^-.*3\.00/);
  assert.match(formatPaperTradePnl(4, 'USDT'), /^\+4\.00 USDT$/);
  assert.throws(() => formatPaperTradePnl(Number.POSITIVE_INFINITY, 'USD'), /finite/);
});
