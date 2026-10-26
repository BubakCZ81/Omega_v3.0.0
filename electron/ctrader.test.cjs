const assert = require('node:assert/strict');
const test = require('node:test');
const { CTraderIntegration } = require('./ctrader.cjs');

function createDemoIntegration(request) {
  const integration = new CTraderIntegration();
  const session = { closed: false, request };
  const account = {
    id: 'demo-account',
    environment: 'demo',
    tradingEnabled: true,
    symbols: new Map([['42', 'TEST']]),
    session,
  };
  integration.activeAccount = account;
  integration.tradingPermissionRequested = true;
  integration.lastQuotes.set('demo-account:42', {
    bid: 100,
    ask: 101,
    receivedAt: Date.now(),
  });
  return integration;
}

test('a superseded cTrader authorization cannot restore a stale session', async () => {
  const integration = new CTraderIntegration({
    openExternal: async () => {},
    fetchImpl: async () => {},
  });
  let releaseAuthorization;
  let authorizationStarted;
  const started = new Promise(resolve => { authorizationStarted = resolve; });
  integration.receiveAuthorizationCode = () => {
    authorizationStarted();
    return new Promise(resolve => { releaseAuthorization = resolve; });
  };
  let exchanged = false;
  integration.exchangeToken = async () => {
    exchanged = true;
    return { accessToken: 'stale', refreshToken: '', expiresAt: Date.now() + 60_000 };
  };

  const attempt = integration.authorize({ clientId: 'client', clientSecret: 'secret' });
  await started;
  await integration.disconnect();
  releaseAuthorization('authorization-code');

  await assert.rejects(attempt, /superseded by a newer request/);
  assert.equal(exchanged, false);
  assert.equal(integration.credentials, null);
  assert.equal(integration.sessions.size, 0);
});

test('disconnect closes cTrader sessions and clears account and quote state', async () => {
  const integration = new CTraderIntegration({
    openExternal: async () => {},
    fetchImpl: async () => {},
  });
  let closed = false;
  const session = { close() { closed = true; } };
  integration.sessions.set('demo', session);
  integration.accounts.set('account', { id: 'account' });
  integration.activeAccount = { id: 'account' };
  integration.lastQuotes.set('account:symbol', { bid: 1, ask: 2, receivedAt: Date.now() });
  integration.credentials = { clientId: 'client', clientSecret: 'secret' };

  await integration.disconnect();

  assert.equal(closed, true);
  assert.equal(integration.sessions.size, 0);
  assert.equal(integration.accounts.size, 0);
  assert.equal(integration.activeAccount, null);
  assert.equal(integration.lastQuotes.size, 0);
  assert.equal(integration.credentials, null);
});

test('a cTrader account selection cannot reactivate after a provider switch', async () => {
  const integration = new CTraderIntegration({
    openExternal: async () => {},
    fetchImpl: async () => {},
  });
  let releaseRequest;
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const session = {
    closed: false,
    request: () => {
      requestStarted();
      return new Promise(resolve => { releaseRequest = resolve; });
    },
    close() { this.closed = true; },
  };
  integration.token = { accessToken: 'token', refreshToken: '', expiresAt: Date.now() + 10 * 60_000 };
  integration.sessions.set('demo', session);
  integration.accounts.set('account', {
    id: 'account',
    environment: 'demo',
    session,
  });

  const attempt = integration.selectAccount('account');
  await started;
  await integration.disconnect();
  releaseRequest({});

  await assert.rejects(attempt, /cancelled by a provider change/);
  assert.equal(integration.activeAccount, null);
});

test('protects a partial cTrader fill, cancels its remainder, and reports its actual volume', async () => {
  const requests = [];
  const integration = createDemoIntegration(async (payloadType, payload) => {
    requests.push({ payloadType, payload });
    if (payloadType === 2106) {
      return {
        executionType: 3,
        order: { orderId: 'order-1' },
        position: { positionId: 'position-1', tradeData: { volume: '250' } },
      };
    }
    if (payloadType === 2108) return { executionType: 5 };
    if (payloadType === 2110) return { executionType: 2 };
    if (payloadType === 2124) {
      return {
        position: [{ positionId: 'position-1', tradeData: { volume: '250' }, stopLoss: 90 }],
        order: [],
      };
    }
    throw new Error(`Unexpected cTrader payload ${payloadType}`);
  });

  const result = await integration.placeDemoMarketOrder({
    symbolId: '42',
    side: 'BUY',
    volume: 5,
    stopLoss: 90,
    confirmed: true,
  });

  assert.equal(result.partialFill, true);
  assert.equal(result.filledVolume, '250');
  assert.equal(result.remainderStatus, 'cancelled');
  assert.equal(result.protected, true);
  assert.deepEqual(requests.map(request => request.payloadType), [2106, 2108, 2110, 2124]);
  assert.equal(requests[1].payload.orderId, 'order-1');
});

test('blocks concurrent cTrader demo orders while the first request is unresolved', async () => {
  let releaseOrder;
  let started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const integration = createDemoIntegration(async payloadType => {
    if (payloadType === 2106) {
      started();
      return new Promise(resolve => { releaseOrder = resolve; });
    }
    if (payloadType === 2110) return { executionType: 2 };
    if (payloadType === 2124) {
      return {
        position: [{ positionId: 'position-2', tradeData: { volume: '500' }, stopLoss: 90 }],
        order: [],
      };
    }
    throw new Error(`Unexpected cTrader payload ${payloadType}`);
  });
  const order = {
    symbolId: '42',
    side: 'BUY',
    volume: 5,
    stopLoss: 90,
    confirmed: true,
  };
  const firstAttempt = integration.placeDemoMarketOrder(order);
  await requestStarted;
  await assert.rejects(integration.placeDemoMarketOrder(order), /already being processed/);

  releaseOrder({
    executionType: 2,
    position: { positionId: 'position-2', tradeData: { volume: '500' } },
  });
  const result = await firstAttempt;
  assert.equal(result.positionId, 'position-2');
  assert.equal(result.protected, true);
});

test('reports a partial cTrader fill whose remainder is still open', async () => {
  const integration = createDemoIntegration(async payloadType => {
    if (payloadType === 2106) {
      return {
        executionType: 'ORDER_PARTIAL_FILL',
        order: { orderId: 'order-3' },
        position: { positionId: 'position-3', tradeData: { volume: '125' } },
      };
    }
    if (payloadType === 2108) return { executionType: 'ORDER_CANCEL_REJECTED' };
    if (payloadType === 2110) return { executionType: 'ORDER_FILLED' };
    if (payloadType === 2124) {
      return {
        position: [{ positionId: 'position-3', tradeData: { volume: '125' }, stopLoss: 90 }],
        order: [{ orderId: 'order-3' }],
      };
    }
    throw new Error(`Unexpected cTrader payload ${payloadType}`);
  });

  const result = await integration.placeDemoMarketOrder({
    symbolId: '42',
    side: 'BUY',
    volume: 5,
    stopLoss: 90,
    confirmed: true,
  });

  assert.equal(result.partialFill, true);
  assert.equal(result.remainderStatus, 'open');
  assert.match(result.remainderCancellationError, /still listed as an open order/);
});

test('does not close a protected-position failure while a partial remainder may still be live', async () => {
  const requests = [];
  const integration = createDemoIntegration(async payloadType => {
    requests.push(payloadType);
    if (payloadType === 2106) {
      return {
        executionType: 3,
        order: { orderId: 'order-4' },
        position: { positionId: 'position-4', tradeData: { volume: '125' } },
      };
    }
    if (payloadType === 2108) return { executionType: 'ORDER_CANCEL_REJECTED' };
    if (payloadType === 2110) return { executionType: 'ORDER_REJECTED', errorCode: 'PROTECTION_REJECTED' };
    throw new Error(`Unexpected cTrader payload ${payloadType}`);
  });

  await assert.rejects(integration.placeDemoMarketOrder({
    symbolId: '42',
    side: 'BUY',
    volume: 5,
    stopLoss: 90,
    confirmed: true,
  }), /partial position because the remainder may still fill.*do not retry the order/);
  assert.equal(requests.includes(2111), false);
});
