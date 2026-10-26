const assert = require('node:assert/strict');
const test = require('node:test');
const { AlpacaMarketData, timeframe } = require('./alpaca.cjs');

test('resolves Vela intraday and higher timeframes', () => {
  assert.deepEqual(timeframe('120'), { api: '1Hour', minutes: 120, sourceMinutes: 60 });
  assert.deepEqual(timeframe('45'), { api: '1Min', minutes: 45, sourceMinutes: 1 });
  assert.deepEqual(timeframe('W'), { api: '1Day', minutes: 10_080, sourceMinutes: 1440, period: 'week' });
  assert.equal(timeframe('M').period, 'month');
  assert.throws(() => timeframe('2D'), /does not support chart timeframe/);
});

test('aggregates minute history into the requested interval and returns chronological bars', async () => {
  const source = [
    { t: '2024-01-02T14:30:00Z', o: 10, h: 12, l: 9, c: 11, v: 100 },
    { t: '2024-01-02T14:31:00Z', o: 11, h: 13, l: 10, c: 12, v: 150 },
    { t: '2024-01-02T14:32:00Z', o: 12, h: 14, l: 11, c: 13, v: 200 },
  ];
  let requestedUrl;
  const market = new AlpacaMarketData({
    fetchImpl: async url => {
      requestedUrl = new URL(url);
      return { ok: true, json: async () => ({ bars: { AAPL: source } }) };
    },
  });
  market.credentials = { keyId: 'key', secretKey: 'secret' };
  market.authenticated = true;

  const bars = await market.bars({ ticker: 'AAPL', timeframe: '2', range: { limit: 2 } });

  assert.equal(requestedUrl.searchParams.get('timeframe'), '1Min');
  assert.equal(requestedUrl.searchParams.get('sort'), 'desc');
  assert.deepEqual(bars, [
    { time: Date.parse('2024-01-02T14:30:00Z'), open: 10, high: 13, low: 9, close: 12, volume: 250 },
    { time: Date.parse('2024-01-02T14:32:00Z'), open: 12, high: 14, low: 11, close: 13, volume: 200 },
  ]);
});

test('accepts empty Alpaca symbol maps as a valid no-bars response', async () => {
  const market = new AlpacaMarketData({
    fetchImpl: async () => ({ ok: true, json: async () => ({ bars: {}, next_page_token: null }) }),
  });
  market.credentials = { keyId: 'key', secretKey: 'secret' };
  market.authenticated = true;

  assert.deepEqual(await market.bars({ ticker: 'AAPL', timeframe: '60', range: { limit: 10 } }), []);
});

test('continues to accept array-shaped bars from older responses', async () => {
  const source = [{ t: '2024-01-02T14:30:00Z', o: 10, h: 12, l: 9, c: 11, v: 100 }];
  const market = new AlpacaMarketData({
    fetchImpl: async () => ({ ok: true, json: async () => ({ bars: source }) }),
  });
  market.credentials = { keyId: 'key', secretKey: 'secret' };
  market.authenticated = true;

  const bars = await market.bars({ ticker: 'AAPL', timeframe: '60', range: { limit: 10 } });

  assert.equal(bars.length, 1);
  assert.equal(bars[0].close, 11);
});

test('matches symbol-keyed history case-insensitively', async () => {
  const source = [{ t: '2024-01-02T14:30:00Z', o: 10, h: 12, l: 9, c: 11, v: 100 }];
  const market = new AlpacaMarketData({
    fetchImpl: async () => ({ ok: true, json: async () => ({ bars: { aapl: source } }) }),
  });
  market.credentials = { keyId: 'key', secretKey: 'secret' };
  market.authenticated = true;

  const bars = await market.bars({ ticker: 'AAPL', timeframe: '60', range: { limit: 10 } });

  assert.equal(bars.length, 1);
  assert.equal(bars[0].close, 11);
});

test('accepts a single symbol array when Alpaca returns a noncanonical key', async () => {
  const source = [{ t: '2024-01-02T14:30:00Z', o: 10, h: 12, l: 9, c: 11, v: 100 }];
  const market = new AlpacaMarketData({
    fetchImpl: async () => ({ ok: true, json: async () => ({ bars: { 'AAPL.US': source } }) }),
  });
  market.credentials = { keyId: 'key', secretKey: 'secret' };
  market.authenticated = true;

  const bars = await market.bars({ ticker: 'AAPL', timeframe: '60', range: { limit: 10 } });

  assert.equal(bars.length, 1);
  assert.equal(bars[0].close, 11);
});

test('reports response structure when Alpaca bars payload is malformed', async () => {
  const market = new AlpacaMarketData({
    fetchImpl: async () => ({ ok: true, json: async () => ({ bars: null, next_page_token: null }) }),
  });
  market.credentials = { keyId: 'key', secretKey: 'secret' };
  market.authenticated = true;

  await assert.rejects(
    market.bars({ ticker: 'AAPL', timeframe: '60', range: { limit: 10 } }),
    /invalid bars list for AAPL \(bars: null; response fields: bars, next_page_token\)/,
  );
});

test('loads the asset catalogue from the Alpaca paper API for paper keys', async () => {
  let requestedUrl;
  const market = new AlpacaMarketData({
    fetchImpl: async url => {
      requestedUrl = new URL(url);
      return {
        ok: true,
        json: async () => [{
          symbol: 'AAPL',
          name: 'Apple Inc.',
          status: 'active',
          asset_class: 'us_equity',
          tradable: true,
          exchange: 'NASDAQ',
        }],
      };
    },
  });
  market.credentials = { keyId: 'PK123', secretKey: 'secret' };
  market.authenticated = true;

  assert.deepEqual(await market.assets(), [{
    ticker: 'AAPL',
    description: 'Apple Inc.',
    exchange: 'NASDAQ',
  }]);
  assert.equal(requestedUrl.origin, 'https://paper-api.alpaca.markets');
  assert.equal(requestedUrl.pathname, '/v2/assets');
  assert.equal(requestedUrl.searchParams.get('status'), 'active');
  assert.equal(requestedUrl.searchParams.get('asset_class'), 'us_equity');
});

test('loads the asset catalogue from the Alpaca live API for live keys', async () => {
  let requestedUrl;
  const market = new AlpacaMarketData({
    fetchImpl: async url => {
      requestedUrl = new URL(url);
      return { ok: true, json: async () => [] };
    },
  });
  market.credentials = { keyId: 'LIVE123', secretKey: 'secret' };
  market.authenticated = true;

  assert.deepEqual(await market.assets(), []);
  assert.equal(requestedUrl.origin, 'https://api.alpaca.markets');
});

test('maps weekly and monthly bars from daily history', async () => {
  const source = [
    { t: '2024-01-01T05:00:00Z', o: 10, h: 12, l: 9, c: 11, v: 100 },
    { t: '2024-01-02T05:00:00Z', o: 11, h: 13, l: 10, c: 12, v: 150 },
    { t: '2024-02-01T05:00:00Z', o: 12, h: 14, l: 11, c: 13, v: 200 },
  ];
  const market = new AlpacaMarketData({
    fetchImpl: async () => ({ ok: true, json: async () => ({ bars: { AAPL: source } }) }),
  });
  market.credentials = { keyId: 'key', secretKey: 'secret' };
  market.authenticated = true;

  const weekly = await market.bars({ ticker: 'AAPL', timeframe: 'W', range: { limit: 10 } });
  const monthly = await market.bars({ ticker: 'AAPL', timeframe: 'M', range: { limit: 10 } });

  assert.equal(weekly.length, 2);
  assert.equal(weekly[0].open, 10);
  assert.equal(weekly[0].close, 12);
  assert.equal(monthly.length, 2);
  assert.equal(monthly[0].volume, 250);
});

test('aggregates daily stream updates for weekly subscriptions', () => {
  const sent = [];
  const market = new AlpacaMarketData({});
  market.authenticated = true;
  market.socket = { send: message => sent.push(JSON.parse(message)) };
  const subscriptionId = market.subscribe('AAPL', 'W');
  const updates = [];
  market.on('bar', bar => updates.push(bar));

  market.handleStreamMessage({
    T: 'd', S: 'AAPL', t: '2024-01-01T05:00:00Z',
    o: 10, h: 12, l: 9, c: 11, v: 100,
  });
  market.handleStreamMessage({
    T: 'd', S: 'AAPL', t: '2024-01-02T05:00:00Z',
    o: 11, h: 13, l: 10, c: 12, v: 150,
  });

  assert.ok(sent.some(message => message.dailyBars?.includes('AAPL')));
  assert.equal(updates.at(-1).subscriptionId, subscriptionId);
  assert.equal(updates.at(-1).open, 10);
  assert.equal(updates.at(-1).close, 12);
  assert.equal(updates.at(-1).volume, 250);
});
