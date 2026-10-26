import assert from 'node:assert/strict';
import test from 'node:test';
import { PersistentCandleProvider } from './persistentCandleCache.ts';

class MemoryCandleStore {
  series = new Map();

  async get(key) {
    return this.series.get(key) ?? [];
  }

  async merge(key, bars) {
    const merged = new Map((this.series.get(key) ?? []).map(bar => [bar.time, bar]));
    for (const bar of bars) merged.set(bar.time, bar);
    const result = [...merged.values()].sort((left, right) => left.time - right.time);
    this.series.set(key, result);
    return result;
  }
}

function candle(time, close = time) {
  return { time, open: close, high: close, low: close, close, volume: 1 };
}

function providerWith(source, store, now) {
  return new PersistentCandleProvider({
    info: () => ({
      name: 'binance',
      capabilities: { enumerate: false, stream: false, symbolInfo: false },
    }),
    getBars: source,
  }, store, () => now);
}

test('persists closed candles but keeps the forming candle out of the cache', async () => {
  const store = new MemoryCandleStore();
  const provider = providerWith(async () => [candle(0), candle(60_000), candle(120_000)], store, 150_000);

  const bars = await provider.getBars('BTCUSDT', '1', { limit: 3 });

  assert.deepEqual(bars.map(bar => bar.time), [0, 60_000, 120_000]);
  assert.deepEqual((await store.get('binance:BTCUSDT:1')).map(bar => bar.time), [0, 60_000]);
});

test('warm loads return cached candles immediately and refresh only the newer tail in background', async () => {
  const store = new MemoryCandleStore();
  await store.merge('binance:BTCUSDT:1', [candle(0), candle(60_000), candle(120_000)]);
  const requests = [];
  const provider = providerWith(async (_ticker, _timeframe, range) => {
    requests.push(range);
    return [candle(120_000), candle(180_000), candle(240_000)];
  }, store, 250_000);

  const bars = await provider.getBars('BTCUSDT', '1', { limit: 3 });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].from, 120_000);
  assert.equal(requests[0].limit, undefined);
  assert.deepEqual(bars.map(bar => bar.time), [0, 60_000, 120_000]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual((await store.get('binance:BTCUSDT:1')).map(bar => bar.time), [0, 60_000, 120_000, 180_000]);
});

test('progressive warm loads publish cached candles before refreshed candles', async () => {
  const store = new MemoryCandleStore();
  await store.merge('binance:BTCUSDT:1', [candle(0), candle(60_000)]);
  const provider = providerWith(async () => [candle(60_000), candle(120_000)], store, 150_000);
  const snapshots = [];

  const bars = await provider.getBarsProgressive(
    'BTCUSDT',
    '1',
    { limit: 3 },
    snapshot => snapshots.push(snapshot.map(bar => bar.time)),
  );

  assert.deepEqual(snapshots, [[0, 60_000], [0, 60_000, 120_000]]);
  assert.deepEqual(bars.map(bar => bar.time), [0, 60_000, 120_000]);
});

test('fully cached historical ranges do not make a provider request', async () => {
  const store = new MemoryCandleStore();
  await store.merge('binance:BTCUSDT:1', [candle(0), candle(60_000), candle(120_000)]);
  let requestCount = 0;
  const provider = providerWith(async () => {
    requestCount += 1;
    return [];
  }, store, 250_000);

  const bars = await provider.getBars('BTCUSDT', '1', { from: 60_000, to: 120_000 });

  assert.deepEqual(bars.map(bar => bar.time), [60_000, 120_000]);
  assert.equal(requestCount, 0);
});
