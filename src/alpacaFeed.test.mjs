import assert from 'node:assert/strict';
import test from 'node:test';
import { AlpacaDataProvider } from './alpacaFeed.ts';

test('requests the Broker SDK supported minute, hourly, and daily timeframes', async () => {
  const requests = [];
  const provider = new AlpacaDataProvider({
    fetchHistoricalBars: async request => {
      requests.push(request);
      return [];
    },
  });
  provider.setConnected(true);

  await provider.getBars('alpaca:aapl', '1', { limit: 20 });
  await provider.getBars('AAPL', '5', { limit: 15 });
  await provider.getBars('AAPL', '15', { limit: 10 });
  await provider.getBars('AAPL', '60', { limit: 10 });
  await provider.getBars('AAPL', 'D', { limit: 5 });

  assert.deepEqual(requests.map(request => [request.symbol, request.timeframe]), [
    ['AAPL', '1m'],
    ['AAPL', '5m'],
    ['AAPL', '15m'],
    ['AAPL', '1h'],
    ['AAPL', '1d'],
  ]);
});

test('uses the Broker SDK date-range API and rejects non-time-based intervals', async () => {
  let request;
  const provider = new AlpacaDataProvider({
    fetchHistoricalBars: async value => {
      request = value;
      return [];
    },
  });
  provider.setConnected(true);

  const now = Date.now();
  await provider.getBars('AAPL', '1D', { limit: 10 });
  assert.equal(request.timeframe, '1d');
  assert.equal(request.symbol, 'AAPL');
  assert.equal(request.limit, 31);
  assert.ok(request.to >= now);
  assert.equal(request.from, request.to - Math.ceil(10 * 24 * 60 * 60_000 * 1.5) - 14 * 24 * 60 * 60_000);
  await assert.rejects(provider.getBars('AAPL', 'T10', { limit: 10 }), /cannot map chart timeframe/);
});

test('extends default minute history across market closures but preserves explicit ranges', async () => {
  const requests = [];
  const provider = new AlpacaDataProvider({
    fetchHistoricalBars: async request => {
      requests.push(request);
      return [];
    },
  });
  provider.setConnected(true);
  const to = Date.UTC(2026, 9, 25, 21);

  await provider.getBars('AAPL', '1', { to, limit: 500 });
  await provider.getBars('AAPL', '5', { to, limit: 500 });
  await provider.getBars('AAPL', '5', { from: to - 10 * 60_000, to, limit: 3 });

  assert.equal(requests[0].from, to - 500 * 60_000 * 6 - 3 * 24 * 60 * 60_000);
  assert.equal(requests[1].from, to - 500 * 5 * 60_000 * 6 - 3 * 24 * 60 * 60_000);
  assert.equal(requests[2].from, to - 10 * 60_000);
});

test('resamples unsupported intraday chart intervals from the nearest supported SDK interval', async () => {
  const minute = 60_000;
  const start = Date.UTC(2026, 9, 26, 14, 30);
  const sourceBars = Array.from({ length: 6 }, (_, index) => ({
    time: start + index * minute,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 10,
  }));
  const requests = [];
  const provider = new AlpacaDataProvider({
    fetchHistoricalBars: async request => {
      requests.push(request);
      return sourceBars;
    },
  });
  provider.setConnected(true);

  const bars = await provider.getBars('AAPL', '3', { from: start, to: start + 6 * minute, limit: 2 });

  assert.equal(requests[0].timeframe, '1m');
  assert.deepEqual(bars, [
    { time: start, open: 100, high: 104, low: 99, close: 103, volume: 30 },
    { time: start + 3 * minute, open: 103, high: 107, low: 102, close: 106, volume: 30 },
  ]);
});

test('resamples multi-hour, multi-day, weekly, and monthly chart intervals', async () => {
  const requests = [];
  const provider = new AlpacaDataProvider({
    fetchHistoricalBars: async request => {
      requests.push(request);
      return [];
    },
  });
  provider.setConnected(true);
  const now = Date.UTC(2026, 9, 26, 14);

  await provider.getBars('AAPL', '120', { to: now, limit: 10 });
  await provider.getBars('AAPL', '2D', { to: now, limit: 10 });
  await provider.getBars('AAPL', 'W', { to: now, limit: 10 });
  await provider.getBars('AAPL', 'M', { to: now, limit: 10 });

  assert.deepEqual(requests.map(request => request.timeframe), ['1h', '1d', '1d', '1d']);
});

test('returns minute bars from the Broker SDK unchanged', async () => {
  const expectedBars = [
    { time: 1_760_000_000_000, open: 100, high: 102, low: 99, close: 101, volume: 42 },
  ];
  let request;
  const provider = new AlpacaDataProvider({
    fetchHistoricalBars: async value => {
      request = value;
      return expectedBars;
    },
  });
  provider.setConnected(true);

  const bars = await provider.getBars('AAPL', '1', { limit: 3000 });

  assert.equal(request.symbol, 'AAPL');
  assert.equal(request.timeframe, '1m');
  assert.deepEqual(bars, expectedBars);
});

test('requires an active Broker SDK connection and does not use a second feed bridge', async () => {
  const provider = new AlpacaDataProvider({
    fetchHistoricalBars: async () => null,
  });

  await assert.rejects(provider.getBars('AAPL', '1', { limit: 10 }), /Connect Alpaca through the Broker panel/);
  provider.setConnected(true);
  await assert.rejects(provider.getBars('AAPL', '1', { limit: 10 }), /Broker SDK history is unavailable/);
});
