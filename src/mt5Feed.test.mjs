import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateMt5Bars,
  initializeMt5Feed,
  Mt5DataProvider,
  resolveMt5Timeframe,
} from './mt5Feed.ts';

function createDeferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class FakeElement extends EventTarget {
  constructor() {
    super();
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.dataset = {};
    this.classList = { add() {}, remove() {}, contains: () => false };
    this.children = [];
  }

  setAttribute() {}
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
}

function createFeedHarness(t, connect) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  const elements = new Map();
  const documentTarget = new EventTarget();
  documentTarget.getElementById = id => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  documentTarget.createElement = () => new FakeElement();
  const registered = [];
  const unregistered = [];
  const chart = {
    data: {
      registerProvider: (name, provider) => { registered.push({ name, provider }); },
      ready: async () => {},
      unregisterProvider: name => { unregistered.push(name); },
    },
  };
  const workspace = {
    cells: () => [{ id: 'cell-1', chart }],
    cell: id => id === 'cell-1' ? { chart } : undefined,
    on: () => () => {},
    active: { setSymbol() {} },
  };
  const symbol = {
    ticker: 'EURUSD',
    description: 'Euro vs US Dollar',
    path: 'Forex\\Majors',
    digits: 5,
    point: 0.00001,
    currencyBase: 'EUR',
    currencyProfit: 'USD',
  };
  documentTarget.dispatchEvent = EventTarget.prototype.dispatchEvent;
  globalThis.document = documentTarget;
  globalThis.window = {
    velaMt5: {
      connect,
      symbols: async () => [symbol],
      bars: async () => [],
      quote: async () => ({ bid: 1, ask: 2 }),
      ticks: async () => [],
      marketBook: async () => [],
      info: async () => symbol,
      disconnect: async () => true,
    },
  };
  initializeMt5Feed(() => workspace);
  return { documentTarget, elements, registered, unregistered, symbol };
}

test('resolves and aggregates MT5 timeframes into chronological OHLCV bars', () => {
  const minute = 60_000;
  const start = Date.UTC(2026, 0, 1);
  const source = Array.from({ length: 4 }, (_, index) => ({
    time: start + index * minute,
    open: 10 + index,
    high: 11 + index,
    low: 9 + index,
    close: 10 + index,
    volume: 2,
  }));

  assert.deepEqual(resolveMt5Timeframe('7'), {
    timeframe: 'M1',
    bucketMs: 7 * minute,
    sourceMinutes: 1,
    targetMinutes: 7,
  });
  assert.deepEqual(aggregateMt5Bars(source, 2 * minute), [
    { time: start, open: 10, high: 12, low: 9, close: 11, volume: 4 },
    { time: start + 2 * minute, open: 12, high: 14, low: 11, close: 13, volume: 4 },
  ]);
});

test('disconnect clears MT5 symbols and prevents future chart history requests', async () => {
  let barsRequested = false;
  const provider = new Mt5DataProvider({
    bars: async () => {
      barsRequested = true;
      return [];
    },
    ticks: async () => [],
    quote: async () => ({ bid: 1, ask: 2 }),
    marketBook: async () => [],
    info: async () => undefined,
  });
  provider.setSymbols([{
    ticker: 'EURUSD',
    description: 'Euro vs US Dollar',
    path: 'Forex\\Majors',
    digits: 5,
    point: 0.00001,
    currencyBase: 'EUR',
    currencyProfit: 'USD',
  }]);
  assert.equal((await provider.listSymbols()).length, 1);

  provider.disconnect();

  assert.deepEqual(await provider.listSymbols(), []);
  await assert.rejects(provider.getBars('EURUSD', '1', { limit: 10 }), /feed is disconnected/);
  assert.equal(barsRequested, false);
});

test('disconnects the MT5 chart provider when another feed starts', async t => {
  const harness = createFeedHarness(t, async () => ({
    company: 'Broker',
    terminal: 'Terminal',
    server: 'Demo',
    symbols: [{
      ticker: 'EURUSD',
      description: 'Euro vs US Dollar',
      path: 'Forex\\Majors',
      digits: 5,
      point: 0.00001,
      currencyBase: 'EUR',
      currencyProfit: 'USD',
    }],
  }));
  const connecting = harness.elements.get('mt5-feed-connect');
  connecting.dispatchEvent(new Event('click'));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(harness.registered.some(item => item.name === 'mt5'));

  harness.documentTarget.dispatchEvent(new CustomEvent('omega:trading-broker-connecting', { detail: 'alpaca' }));

  assert.ok(harness.unregistered.includes('mt5'));
});

test('ignores an MT5 connection response superseded by another feed', async t => {
  const connection = createDeferred();
  const harness = createFeedHarness(t, () => connection.promise);
  harness.elements.get('mt5-feed-connect').dispatchEvent(new Event('click'));
  await new Promise(resolve => setImmediate(resolve));
  harness.documentTarget.dispatchEvent(new CustomEvent('omega:trading-broker-connecting', { detail: 'ctrader' }));
  connection.resolve({
    company: 'Broker',
    terminal: 'Terminal',
    server: 'Demo',
    symbols: [harness.symbol],
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.registered.some(item => item.name === 'mt5'), false);
});
