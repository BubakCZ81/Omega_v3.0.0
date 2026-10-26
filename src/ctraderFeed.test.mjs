import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeCTraderFeed } from './ctraderFeed.ts';

function createDeferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function createHarness(t, ready = Promise.resolve()) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });

  const registered = [];
  const unregistered = [];
  const documentTarget = new EventTarget();
  documentTarget.createElement = () => ({});
  const chart = {
    data: {
      registerProvider: (name, provider) => { registered.push({ name, provider }); },
      ready: () => ready,
      unregisterProvider: name => { unregistered.push(name); },
    },
    setMarket: async () => {},
  };
  const workspace = {
    cells: () => [{ id: 'cell-1', chart }],
    cell: id => id === 'cell-1' ? { chart } : undefined,
    on: () => () => {},
    chart,
  };
  globalThis.document = documentTarget;
  globalThis.window = {
    velaCTraderFeed: {
      symbols: async () => [],
      bars: async () => [],
      subscribeSymbol: async () => 'subscription',
      unsubscribe: async () => true,
      onQuote: () => () => {},
    },
  };
  initializeCTraderFeed(() => workspace);
  return { documentTarget, registered, unregistered };
}

test('unregisters the cTrader chart provider when another feed is starting', async t => {
  const harness = createHarness(t);
  harness.documentTarget.dispatchEvent(new CustomEvent('omega:ctrader-account-selected', {
    detail: [{ id: 'symbol-1', name: 'EURUSD' }],
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.registered.some(item => item.name === 'ctrader'), true);

  harness.documentTarget.dispatchEvent(new CustomEvent('omega:trading-broker-connecting', { detail: 'mt5' }));

  assert.ok(harness.unregistered.includes('ctrader'));
});

test('a delayed chart registration cannot survive a provider switch', async t => {
  const ready = createDeferred();
  const harness = createHarness(t, ready.promise);
  harness.documentTarget.dispatchEvent(new CustomEvent('omega:ctrader-account-selected', {
    detail: [{ id: 'symbol-1', name: 'EURUSD' }],
  }));
  await new Promise(resolve => setImmediate(resolve));

  harness.documentTarget.dispatchEvent(new CustomEvent('omega:trading-broker-connecting', { detail: 'alpaca' }));
  ready.resolve();
  await new Promise(resolve => setImmediate(resolve));

  assert.ok(harness.unregistered.includes('ctrader'));
});
