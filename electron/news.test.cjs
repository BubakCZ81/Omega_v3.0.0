const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeNewsQuery, safeNewsLink, searchYahooNews } = require('./news.cjs');

test('normalizeNewsQuery trims valid symbols and rejects unsafe ones', () => {
  assert.equal(normalizeNewsQuery(' BTCUSDT '), 'BTCUSDT');
  assert.equal(normalizeNewsQuery('EURUSD'), 'EURUSD');
  assert.equal(normalizeNewsQuery('^GSPC'), '^GSPC');
  assert.throws(() => normalizeNewsQuery('   '), /symbol is required/);
  assert.throws(() => normalizeNewsQuery(42), /symbol is required/);
  assert.throws(() => normalizeNewsQuery('a'.repeat(81)), /unsupported characters/);
  assert.throws(() => normalizeNewsQuery('BTC<script>'), /unsupported characters/);
});

test('safeNewsLink only allows plain https links', () => {
  assert.equal(safeNewsLink('https://finance.yahoo.com/news/a'), 'https://finance.yahoo.com/news/a');
  assert.equal(safeNewsLink('http://finance.yahoo.com/news/a'), null);
  assert.equal(safeNewsLink('javascript:alert(1)'), null);
  assert.equal(safeNewsLink('https://user:pass@example.com/a'), null);
  assert.equal(safeNewsLink('not a url'), null);
  assert.equal(safeNewsLink(null), null);
});

test('searchYahooNews maps, deduplicates and limits provider items', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        news: [
          { uuid: 'n1', title: 'Bitcoin rallies', publisher: 'Reuters', link: 'https://example.com/a', providerPublishTime: 1_700_000_000, relatedTickers: ['BTCUSDT', 42] },
          { uuid: 'n1', title: 'Duplicate', publisher: 'Reuters', link: 'https://example.com/b', providerPublishTime: 1_700_000_001 },
          { uuid: 'n2', title: 'Bad link', publisher: 'Reuters', link: 'javascript:alert(1)', providerPublishTime: 1_700_000_002 },
          { uuid: 'n3', title: 'Missing publisher', link: 'https://example.com/c', providerPublishTime: 1_700_000_003 },
          { uuid: 'n4', title: 'No timestamp', publisher: 'AP', link: 'https://example.com/d' },
          { uuid: 'n5', title: 'Valid second item', publisher: 'AP', link: 'https://example.com/e', providerPublishTime: 1_700_000_004 },
          null,
        ],
      }),
    };
  };

  const items = await searchYahooNews('BTCUSDT', fetchImpl);
  assert.deepEqual(items, [
    {
      id: 'n1',
      title: 'Bitcoin rallies',
      publisher: 'Reuters',
      link: 'https://example.com/a',
      publishedAt: 1_700_000_000_000,
      relatedTickers: ['BTCUSDT'],
    },
    {
      id: 'n5',
      title: 'Valid second item',
      publisher: 'AP',
      link: 'https://example.com/e',
      publishedAt: 1_700_000_004_000,
      relatedTickers: [],
    },
  ]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/query1\.finance\.yahoo\.com\/v1\/finance\/search\?/);
  assert.equal(calls[0].options.headers.Accept, 'application/json');
});

test('searchYahooNews surfaces provider and payload errors', async () => {
  await assert.rejects(
    () => searchYahooNews('BTC', async () => ({ ok: false, status: 429 })),
    /HTTP 429/,
  );
  await assert.rejects(
    () => searchYahooNews('BTC', async () => ({ ok: true, json: async () => ({ news: null }) })),
    /invalid response/,
  );
});
