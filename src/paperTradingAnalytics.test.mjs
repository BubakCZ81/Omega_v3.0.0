import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePaperAccount } from './paperTradingAnalytics.ts';

const closed = [
  { id: 'p1', side: 'buy', lots: 1, entryPrice: 100, entryTime: 1_000, closePrice: 110, closeTime: 2_000, pnl: 1_000, commission: 2 },
  { id: 'p2', side: 'sell', lots: 2, entryPrice: 110, entryTime: 3_000, closePrice: 115, closeTime: 4_000, pnl: -500 },
];
const open = [
  { id: 'p3', side: 'buy', lots: 1, entryPrice: 100, entryTime: 5_000, pnl: 250 },
];

test('calculatePaperAccount reports realised, open and combined equity', () => {
  const account = calculatePaperAccount(100_000, closed, open);
  assert.equal(account.initialCapital, 100_000);
  assert.equal(account.realisedPnl, 500);
  assert.equal(account.openPnl, 250);
  assert.equal(account.equity, 100_750);
  assert.equal(account.analytics.ledgerClosedTrades, 2);
  assert.equal(account.analytics.openTrades, 1);
  assert.equal(account.analytics.winRate, 50);
  assert.equal(account.analytics.totalCommission, 2);
  assert.equal(account.analytics.longProfit, 1_000);
  assert.equal(account.analytics.shortProfit, -500);
});

test('calculatePaperAccount tracks peak-to-trough drawdown in close order', () => {
  const account = calculatePaperAccount(10_000, [
    { id: 'a', side: 'buy', lots: 1, entryPrice: 1, entryTime: 1, closePrice: 2, closeTime: 2, pnl: 1_000 },
    { id: 'b', side: 'sell', lots: 1, entryPrice: 2, entryTime: 3, closePrice: 3, closeTime: 4, pnl: -1_500 },
    { id: 'c', side: 'buy', lots: 1, entryPrice: 1, entryTime: 5, closePrice: 2, closeTime: 6, pnl: 200 },
  ], []);
  assert.equal(account.analytics.maxDrawdown, 1_500);
  assert.equal(account.analytics.maxRunup, 1_000);
  assert.equal(account.equity, 9_700);
});

test('calculatePaperAccount falls back to the default capital for invalid input', () => {
  const account = calculatePaperAccount(0, [], []);
  assert.equal(account.initialCapital, 100_000);
  assert.equal(account.equity, 100_000);
  assert.equal(account.analytics.winRate, null);
  assert.deepEqual(account.analytics.realizedEquity, []);
});
