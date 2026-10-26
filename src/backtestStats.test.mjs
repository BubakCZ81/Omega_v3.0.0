import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateBacktestAnalytics, calculateBacktestMetrics } from './backtestStats.ts';

const initialCapital = 100_000;

function state(overrides = {}) {
  return {
    position: 0,
    avgPrice: 0,
    equity: 100_800,
    openPnl: 500,
    netPnl: 800,
    grossProfit: 1_000,
    grossLoss: 200,
    wins: 2,
    losses: 1,
    even: 0,
    maxDrawdown: 200,
    maxRunup: 800,
    initialCapital,
    ...overrides,
  };
}

function trade(id, side, pnl, { exitTime = 2_000, entryTime = 1_000, commission = 0, open = false } = {}) {
  return {
    id,
    side,
    qty: 1,
    entry: { id: `${id}:entry`, time: entryTime, price: 100 },
    ...(open ? {} : { exit: { id: `${id}:exit`, time: exitTime, price: 101 } }),
    open,
    pnl,
    commission,
  };
}

const closedTrades = [
  trade('t1', 'long', 600, { exitTime: Date.UTC(2024, 0, 10) }),
  trade('t2', 'short', -200, { exitTime: Date.UTC(2024, 0, 20) }),
  trade('t3', 'long', 400, { exitTime: Date.UTC(2024, 1, 5) }),
];
const openTrades = [trade('t4', 'long', 500, { open: true })];

test('calculateBacktestMetrics derives win rate, profit factor and returns', () => {
  const metrics = calculateBacktestMetrics(state(), [...closedTrades, ...openTrades]);
  assert.equal(metrics.closedTrades, 3);
  assert.equal(metrics.openTrades, 1);
  assert.equal(metrics.winRate, (2 / 3) * 100);
  assert.equal(metrics.profitFactor, 5);
  assert.equal(metrics.equity, 100_800);
  assert.equal(metrics.netProfit, 800);
  assert.equal(metrics.openProfit, 500);
  assert.equal(metrics.returnPercent, 0.8);
  assert.equal(metrics.drawdownPercent, 0.2);
});

test('profit factor is Infinity without losses and null without closed outcomes', () => {
  const winsOnly = calculateBacktestMetrics(state({ wins: 1, losses: 0 }), [trade('w', 'long', 250)]);
  assert.equal(winsOnly.profitFactor, Infinity);
  const empty = calculateBacktestMetrics(state({ wins: 0, losses: 0, netPnl: 0 }), []);
  assert.equal(empty.winRate, null);
  assert.equal(empty.profitFactor, null);
  assert.equal(empty.returnPercent, 0);
});

test('calculateBacktestAnalytics builds ledger statistics, streaks and monthly buckets', () => {
  const analytics = calculateBacktestAnalytics(state(), [...openTrades, ...closedTrades]);
  assert.equal(analytics.ledgerClosedTrades, 3);
  assert.equal(analytics.grossProfit, 1_000);
  assert.equal(analytics.longTrades, 2);
  assert.equal(analytics.shortTrades, 1);
  assert.equal(analytics.longProfit, 1_000);
  assert.equal(analytics.shortProfit, -200);
  assert.equal(analytics.averageTrade, 800 / 3);
  assert.equal(analytics.averageWin, 500);
  assert.equal(analytics.averageLoss, -200);
  assert.equal(analytics.payoffRatio, 2.5);
  assert.equal(analytics.largestWin, 600);
  assert.equal(analytics.largestLoss, -200);
  assert.equal(analytics.longestWinStreak, 1);
  assert.equal(analytics.longestLossStreak, 1);
  assert.deepEqual(analytics.realizedEquity.map(point => point.equity), [100_600, 100_400, 100_800]);
  assert.deepEqual(analytics.realizedEquity.map(point => point.drawdown), [0, 200, 0]);
  assert.deepEqual(analytics.monthly, [
    { month: '2024-01', netProfit: 400, trades: 2, wins: 1, losses: 1 },
    { month: '2024-02', netProfit: 400, trades: 1, wins: 1, losses: 0 },
  ]);
});

test('monthly buckets use UTC boundaries regardless of the local time zone', () => {
  const analytics = calculateBacktestAnalytics(state({ wins: 1, losses: 1, netPnl: 50 }), [
    trade('late-january', 'long', 100, { exitTime: Date.UTC(2024, 0, 31, 23, 30) }),
    trade('early-february', 'short', -50, { exitTime: Date.UTC(2024, 1, 1, 0, 30) }),
  ]);
  assert.deepEqual(analytics.monthly.map(month => month.month), ['2024-01', '2024-02']);
});

test('analytics ignore trades without a finite pnl and sort by exit time', () => {
  const unordered = [
    trade('late', 'long', 100, { exitTime: 30_000 }),
    trade('missing', 'long', undefined, { exitTime: 20_000 }),
    trade('early', 'short', -50, { exitTime: 10_000 }),
  ];
  const analytics = calculateBacktestAnalytics(state({ wins: 1, losses: 1 }), unordered);
  assert.equal(analytics.ledgerClosedTrades, 2);
  assert.deepEqual(analytics.realizedEquity.map(point => point.equity), [99_950, 100_050]);
});
