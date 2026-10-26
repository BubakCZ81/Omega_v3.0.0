import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchBidAskQuote, isQuoteResponse } from './bidAskLines.ts';

test('validates a positive, ordered bid/ask quote', () => {
  assert.equal(isQuoteResponse({ bid: 1.1, ask: 1.2 }), true);
  assert.equal(isQuoteResponse({ bid: 0, ask: 1 }), false);
  assert.equal(isQuoteResponse({ bid: 2, ask: 1 }), false);
  assert.equal(isQuoteResponse({ bid: Number.NaN, ask: 2 }), false);
});

test('reads MT5 bid/ask data through the current desktop bridge', async t => {
  const previousWindow = globalThis.window;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  globalThis.window = { velaMt5: { quote: async ticker => {
    assert.equal(ticker, 'EURUSD');
    return { bid: 1.08, ask: 1.0802 };
  } } };

  assert.deepEqual(await fetchBidAskQuote('mt5', 'EURUSD', new AbortController().signal), {
    bid: 1.08,
    ask: 1.0802,
  });
});
