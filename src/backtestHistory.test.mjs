import assert from 'node:assert/strict';
import test from 'node:test';
import { BacktestHistoryProvider, loadBacktestHistory, registerBacktestHistoryProvider } from './backtestHistory.ts';

test('loads older pages until the selected backtest range is covered', async () => {
  const requests = [];
  const provider = {
    getBars: async (ticker, timeframe, range) => {
      requests.push({ ticker, timeframe, range });
      const times = Array.from({ length: 11 }, (_, index) => index)
        .filter(time => time >= range.from && time <= range.to)
        .slice(-3);
      return times.map(time => ({ time, open: time, high: time, low: time, close: time }));
    },
  };

  const bars = await loadBacktestHistory(provider, 'AAPL', '1', 0, 10, () => true);

  assert.deepEqual(bars.map(bar => bar.time), Array.from({ length: 11 }, (_, index) => index));
  assert.equal(requests.length, 4);
  assert.ok(requests.every(request => request.ticker === 'AAPL' && request.timeframe === '1'));
});

test('uses the exact selected-range candles for initial chart history, then delegates range requests', async () => {
  const initialBars = [{ time: 1, open: 1, high: 1, low: 1, close: 1 }];
  const delegated = [];
  const source = {
    getBars: async (...args) => {
      delegated.push(args);
      return [];
    },
  };
  const provider = new BacktestHistoryProvider(source, 'omega-backtest-1', initialBars);

  assert.deepEqual(await provider.getBars('AAPL', '1', { limit: 1 }), initialBars);
  assert.deepEqual(await provider.getBars('AAPL', '1', { to: 1, limit: 1 }), []);
  assert.equal(delegated.length, 1);
});

test('unregisters a history provider when its request is cancelled during chart readiness', async () => {
  let current = true;
  const registered = [];
  const unregistered = [];
  const registry = {
    registerProvider: (name, provider) => registered.push({ name, provider }),
    unregisterProvider: name => unregistered.push(name),
    ready: async () => { current = false; },
  };

  const provider = await registerBacktestHistoryProvider(
    registry,
    { getBars: async () => [] },
    'omega-backtest-2',
    [],
    () => current,
  );

  assert.equal(provider, null);
  assert.equal(registered.length, 1);
  assert.deepEqual(unregistered, ['omega-backtest-2']);
});

test('unregisters a history provider when chart readiness fails', async () => {
  const unregistered = [];
  const error = new Error('Chart readiness failed');
  const registry = {
    registerProvider: () => {},
    unregisterProvider: name => unregistered.push(name),
    ready: async () => { throw error; },
  };

  await assert.rejects(
    registerBacktestHistoryProvider(registry, { getBars: async () => [] }, 'omega-backtest-3', [], () => true),
    error,
  );
  assert.deepEqual(unregistered, ['omega-backtest-3']);
});
